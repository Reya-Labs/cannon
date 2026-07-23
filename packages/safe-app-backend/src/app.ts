import { createHash, randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { getAddress, isAddress, type Address } from 'viem';
import { ZodError } from 'zod';
import { getActor, proxyAuthenticator, requireAnyRole } from './auth';
import type { AppConfig } from './config';
import { HttpError, isHttpError } from './errors';
import {
  checkSafeReadiness,
  filterCurrentOwnerSignatures,
  getSafeDigest,
  getSafeNonce,
  stageRequestSchema,
  supersedeRequestSchema,
  validateSignatures,
} from './safe';
import { RedisStagingStore } from './store';
import type { ProposalAdmissionVerifier, ProviderRegistry, SafeClient, SafeTransaction, StoredProposal } from './types';

type AppDependencies = {
  admissionVerifier: ProposalAdmissionVerifier;
  config: AppConfig;
  now?: () => number;
  providers: ProviderRegistry;
  store: RedisStagingStore;
};

const appVersion = process.env.BUILD_REVISION ?? 'unknown';

function errorIdentity(error: unknown): { code: string; name: string } {
  return {
    code:
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unexpected',
    name: error instanceof Error ? error.name : 'unknown',
  };
}

function requestId(req: Request): string {
  const supplied = req.get('x-request-id');
  return supplied && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : randomUUID();
}

function supersedeIdempotencyKey(req: Request): string {
  const supplied = req.get('x-idempotency-key')?.trim();
  if (!supplied || !/^[a-zA-Z0-9._:-]{16,128}$/.test(supplied)) {
    throw new HttpError(
      400,
      'invalid_idempotency_key',
      'X-Idempotency-Key must contain 16-128 letters, digits, dots, underscores, colons or dashes'
    );
  }
  return createHash('sha256').update(supplied).digest('hex');
}

function parseTarget(
  config: AppConfig,
  providers: ProviderRegistry,
  params: { chainId: string; safeAddress: string }
): { chainId: number; client: SafeClient; safeAddress: Address } {
  if (!/^[1-9][0-9]*$/.test(params.chainId)) {
    throw new HttpError(400, 'invalid_chain', 'chainId must be a positive integer');
  }
  const chainId = Number(params.chainId);
  if (!Number.isSafeInteger(chainId)) throw new HttpError(400, 'invalid_chain', 'chainId is out of range');
  if (!isAddress(params.safeAddress)) throw new HttpError(400, 'invalid_safe', 'safeAddress is invalid');
  const safeAddress = getAddress(params.safeAddress);
  if (!config.safeAllowlist.get(chainId)?.has(safeAddress)) {
    throw new HttpError(404, 'safe_not_allowed', 'chain and Safe are not configured');
  }

  const client = providers.get(chainId);
  if (!client) throw new HttpError(503, 'rpc_unavailable', 'configured chain RPC is unavailable');
  return { chainId, client, safeAddress };
}

async function asRpcRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(503, 'rpc_unavailable', 'required Safe RPC read failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function toResponse(
  proposal: StoredProposal | null,
  client: SafeClient,
  safeAddress: Address
): Promise<
  Array<{
    createdAt: number;
    sigs: string[];
    txn: SafeTransaction;
    updatedAt: number;
  }>
> {
  if (!proposal) return [];
  const sigs = await asRpcRead(() => filterCurrentOwnerSignatures(client, safeAddress, proposal.digest, proposal.sigs));
  return [
    {
      createdAt: proposal.createdAt,
      sigs,
      txn: proposal.txn,
      updatedAt: proposal.updatedAt,
    },
  ];
}

export function createApp({ admissionVerifier, config, now = Date.now, providers, store }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(morgan('tiny'));
  app.use(helmet());

  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      if (!config.corsOrigins.has(origin)) {
        return next(new HttpError(403, 'origin_forbidden', 'request origin is not allowed'));
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Idempotency-Key,X-Request-Id');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get('/livez', (_req, res) => {
    res.json({ status: 'ok', version: appVersion });
  });

  let readinessResult: { error?: unknown; expiresAt: number } | undefined;
  let readinessCheck: Promise<void> | undefined;
  const checkReadiness = async (): Promise<void> => {
    const timestamp = now();
    if (readinessResult && timestamp < readinessResult.expiresAt) {
      if (readinessResult.error) throw readinessResult.error;
      return;
    }
    if (!readinessCheck) {
      readinessCheck = (async () => {
        try {
          await store.ping();
          await Promise.all(
            config.safeTargets.map(({ address, chainId }) => {
              const client = providers.get(chainId);
              if (!client) throw new Error(`RPC client for chain ${chainId} is not configured`);
              return checkSafeReadiness(client, address, chainId, config.maxBlockAgeSeconds, now());
            })
          );
          readinessResult = { expiresAt: now() + config.readinessCacheMs };
        } catch (error) {
          readinessResult = { error, expiresAt: now() + config.readinessCacheMs };
          throw error;
        } finally {
          readinessCheck = undefined;
        }
      })();
    }
    return readinessCheck;
  };
  const readiness = async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await checkReadiness();
      res.json({ status: 'ok', version: appVersion });
    } catch (error) {
      next(isHttpError(error) ? error : new HttpError(503, 'not_ready', 'a required dependency is not ready'));
    }
  };
  app.get('/readyz', readiness);
  app.get('/health', readiness);

  app.use(proxyAuthenticator(config));
  app.use(
    rateLimit({
      keyGenerator: (req) => (req as Request & { actor?: { subject: string } }).actor?.subject ?? 'unknown',
      legacyHeaders: false,
      limit: config.rateLimit.limit,
      message: { error: { code: 'rate_limited', message: 'too many requests' } },
      passOnStoreError: false,
      standardHeaders: 'draft-7',
      validate: false,
      windowMs: config.rateLimit.windowMs,
    })
  );
  app.use(express.json({ limit: config.bodyLimit, strict: true }));

  app.get('/:chainId/:safeAddress', async (req, res, next) => {
    try {
      const actor = getActor(req);
      requireAnyRole(actor, 'operator', 'proposer', 'signer');
      const { chainId, client, safeAddress } = parseTarget(config, providers, req.params);
      const nonce = await asRpcRead(() => getSafeNonce(client, safeAddress));
      await store.reconcileCurrentNonce(chainId, safeAddress, nonce);
      const proposal = await store.getActive(chainId, safeAddress, nonce);
      res.json(await toResponse(proposal, client, safeAddress));
    } catch (error) {
      next(error);
    }
  });

  app.post('/:chainId/:safeAddress', async (req, res, next) => {
    try {
      const actor = getActor(req);
      requireAnyRole(actor, 'proposer', 'signer');
      const { chainId, client, safeAddress } = parseTarget(config, providers, req.params);
      const parsed = stageRequestSchema.parse(req.body);
      const txn = parsed.txn as SafeTransaction;

      const currentNonce = await asRpcRead(() => getSafeNonce(client, safeAddress));
      await store.reconcileCurrentNonce(chainId, safeAddress, currentNonce);
      if (txn._nonce !== currentNonce) {
        throw new HttpError(409, 'stale_or_future_nonce', 'proposal nonce must equal the current Safe nonce', {
          currentNonce,
          proposedNonce: txn._nonce,
        });
      }

      const digest = await asRpcRead(() => getSafeDigest(client, safeAddress, txn));
      const admission = await admissionVerifier.verify({
        actor,
        attestation: parsed.attestation,
        chainId,
        safeAddress,
        safeTxHash: digest,
        txn,
      });
      const signatures = await asRpcRead(() => validateSignatures(client, safeAddress, digest, parsed.sigs));
      const merge = await store.mergeProposal({
        actor,
        admissionId: admission.id,
        canCreate: actor.roles.has('proposer'),
        chainId,
        digest,
        proposalTtlMs: config.proposalTtlMs,
        requestId: requestId(req),
        safeAddress,
        signatures,
        txn,
      });
      const confirmedNonce = await asRpcRead(() => getSafeNonce(client, safeAddress));
      if (confirmedNonce !== currentNonce) {
        await store.reconcileCurrentNonce(chainId, safeAddress, confirmedNonce);
        throw new HttpError(409, 'safe_nonce_advanced', 'Safe nonce advanced while the proposal was being stored', {
          currentNonce: confirmedNonce,
          proposedNonce: txn._nonce,
        });
      }
      const proposal = await store.getActive(chainId, safeAddress, currentNonce);
      res.status(merge.created ? 201 : 200).json(await toResponse(proposal, client, safeAddress));
    } catch (error) {
      next(error);
    }
  });

  app.post('/:chainId/:safeAddress/supersede', async (req, res, next) => {
    try {
      const actor = getActor(req);
      requireAnyRole(actor, 'operator', 'proposer');
      const { chainId, client, safeAddress } = parseTarget(config, providers, req.params);
      const { expectedDigest, reason } = supersedeRequestSchema.parse(req.body);
      const nonce = await asRpcRead(() => getSafeNonce(client, safeAddress));
      await store.reconcileCurrentNonce(chainId, safeAddress, nonce);
      const supersession = await store.supersede({
        actor,
        chainId,
        expectedDigest,
        idempotencyKey: supersedeIdempotencyKey(req),
        nonce,
        reason,
        requestId: requestId(req),
        safeAddress,
      });
      if (supersession.originalNonce !== nonce) {
        await store.reclassifySupersededAsStale(
          chainId,
          safeAddress,
          supersession.originalNonce,
          nonce,
          supersession.digest
        );
        throw new HttpError(409, 'safe_nonce_advanced', 'Safe nonce advanced while the proposal was superseded', {
          currentNonce: nonce,
          proposedNonce: supersession.originalNonce,
        });
      }
      const confirmedNonce = await asRpcRead(() => getSafeNonce(client, safeAddress));
      if (confirmedNonce !== nonce) {
        if (confirmedNonce > nonce) {
          await store.reclassifySupersededAsStale(chainId, safeAddress, nonce, confirmedNonce, supersession.digest);
        } else {
          await store.reconcileCurrentNonce(chainId, safeAddress, confirmedNonce);
        }
        throw new HttpError(409, 'safe_nonce_advanced', 'Safe nonce advanced while the proposal was superseded', {
          currentNonce: confirmedNonce,
          proposedNonce: nonce,
        });
      }
      res.json({ digest: supersession.digest, status: 'superseded' });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, _res, next) => {
    next(new HttpError(404, 'not_found', 'route not found'));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: {
          code: 'invalid_request',
          details: error.issues.map(({ code, message, path }) => ({ code, message, path })),
          message: 'request body failed validation',
        },
      });
    }

    if (isHttpError(error)) {
      return res.status(error.status).json({
        error: {
          code: error.code,
          ...(error.status < 500 && error.details !== undefined ? { details: error.details } : {}),
          message: error.message,
        },
      });
    }

    const bodyParserError = error as { status?: number; type?: string };
    if (bodyParserError.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'body_too_large', message: 'request body is too large' } });
    }
    if (bodyParserError.status === 400) {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'request body is not valid JSON' } });
    }

    console.error('unexpected request failure', errorIdentity(error));
    return res.status(500).json({ error: { code: 'internal_error', message: 'unexpected server error' } });
  });

  return app;
}
