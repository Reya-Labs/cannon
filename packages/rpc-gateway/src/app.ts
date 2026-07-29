import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { proxyAuthenticator } from './auth';
import type { AppConfig } from './config';
import { HttpError, isHttpError, QuorumError } from './errors';
import { parseStrictJson } from './json';
import { WindowCostLimiter, WorkLimiter } from './limits';
import { QuorumService, toUnavailable } from './quorum';
import { decodeRpcRequest, prepareRequest } from './schema';

const appVersion = process.env.BUILD_REVISION ?? 'unknown';

function rateLimiter(config: AppConfig, authenticated: boolean) {
  return rateLimit({
    keyGenerator: authenticated ? (_req, res) => String(res.locals.actor ?? 'unknown') : (req) => req.ip ?? 'unknown',
    legacyHeaders: false,
    limit: authenticated ? config.limits.rateLimit : config.limits.rateLimit * 4,
    message: { error: { code: 'rate_limited', message: 'too many requests' } },
    passOnStoreError: false,
    standardHeaders: 'draft-7',
    validate: false,
    windowMs: config.limits.rateLimitWindowMs,
  });
}

export function createApp(config: AppConfig, quorum: QuorumService): Express {
  const app = express();
  const limiter = new WorkLimiter(config.limits.concurrency, config.limits.queue, config.quorum.timeoutMs);
  const actorCosts = new WindowCostLimiter(config.limits.rateLimit, config.limits.rateLimitWindowMs);
  const globalCosts = new WindowCostLimiter(config.limits.rateLimit * 20, config.limits.rateLimitWindowMs, 1);
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      if (origin !== config.uiOrigin) return next(new HttpError(403, 'origin_forbidden', 'request origin is not allowed'));
      res.setHeader('Access-Control-Allow-Origin', config.uiOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      if (origin !== config.uiOrigin) return next(new HttpError(403, 'origin_forbidden', 'request origin is not allowed'));
      return res.status(204).end();
    }
    next();
  });
  app.use(rateLimiter(config, false));
  app.get('/livez', (_req, res) => res.json({ status: 'ok', version: appVersion }));
  app.get('/readyz', async (_req, res) => {
    try {
      await quorum.readiness();
      res.json({ status: 'ok', version: appVersion });
    } catch {
      res.status(503).json({ status: 'unavailable', version: appVersion });
    }
  });

  app.use((req, _res, next) => {
    if (req.get('origin') !== config.uiOrigin) {
      return next(new HttpError(403, 'origin_forbidden', 'request origin is required'));
    }
    next();
  });
  app.use(proxyAuthenticator(config));
  app.use(rateLimiter(config, true));
  app.use((req, _res, next) => {
    if (req.get('content-encoding') !== undefined) {
      return next(new HttpError(415, 'content_encoding_forbidden', 'compressed RPC requests are forbidden'));
    }
    next();
  });
  app.use(express.raw({ inflate: false, limit: config.limits.bodyBytes, type: 'application/json' }));

  app.post('/rpc/1729', async (req, res, next) => {
    const gatewayRequestId = randomUUID();
    const startedAt = Date.now();
    let rpcMethod = 'invalid';
    try {
      if (req.originalUrl.includes('?')) {
        throw new HttpError(400, 'query_forbidden', 'RPC requests must not contain a query string');
      }
      if (!Buffer.isBuffer(req.body)) {
        throw new HttpError(415, 'content_type_required', 'Content-Type must be application/json');
      }
      const request = decodeRpcRequest(parseStrictJson(req.body));
      const prepared = prepareRequest(request, config.limits.calldataBytes);
      rpcMethod = prepared.method;
      actorCosts.consume(String(res.locals.actor), prepared.cost);
      globalCosts.consume('global', prepared.cost);
      const response = await limiter.run(() => quorum.execute(prepared));
      console.info(
        JSON.stringify({
          cost: prepared.cost,
          durationMs: Date.now() - startedAt,
          method: prepared.method,
          outcome: response.kind,
          requestId: gatewayRequestId,
        })
      );
      if (response.kind === 'error') {
        return res.json({
          error: {
            code: response.code,
            ...(response.data === undefined ? {} : { data: response.data }),
            message: response.message,
          },
          id: request.id,
          jsonrpc: '2.0',
        });
      }
      return res.json({ id: request.id, jsonrpc: '2.0', result: response.result });
    } catch (error) {
      console.warn(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          method: rpcMethod,
          outcome: error instanceof QuorumError ? error.category : 'rejected',
          requestId: gatewayRequestId,
        })
      );
      next(toUnavailable(error));
    }
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'route not found')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (isHttpError(error)) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    if (typeof error === 'object' && error !== null && 'type' in error) {
      if (error.type === 'entity.too.large') {
        return res
          .status(413)
          .json({ error: { code: 'body_too_large', message: 'request body exceeds the configured limit' } });
      }
      if (error.type === 'encoding.unsupported') {
        return res
          .status(415)
          .json({ error: { code: 'content_encoding_forbidden', message: 'compressed RPC requests are forbidden' } });
      }
    }
    console.error('unexpected RPC gateway failure', { name: error instanceof Error ? error.name : 'unknown' });
    return res.status(500).json({ error: { code: 'internal_error', message: 'unexpected RPC gateway error' } });
  });
  return app;
}
