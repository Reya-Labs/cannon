import { isIP } from 'node:net';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive();
const nonnegativeInteger = z.coerce.number().int().nonnegative();
const admissionMode = z.enum(['safe-owner']);
const REYA_CHAIN_ID = 1729;
const headerName = z
  .string()
  .regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/)
  .transform((value) => value.toLowerCase());

export type SafeTarget = {
  address: Address;
  chainId: number;
};

export type AdmissionMode = z.infer<typeof admissionMode>;

export type AppConfig = {
  admissionMode: AdmissionMode;
  auditMaxLength: number;
  auth: {
    identityHeader: string;
    proxySecret: string;
    proxySecretHeader: string;
    rolesHeader: string;
  };
  bodyLimit: string;
  corsOrigins: Set<string>;
  historyRetentionMs: number;
  maxBlockAgeSeconds: number;
  maxProposalsPerNonce: number;
  port: number;
  proposalTtlMs: number;
  readinessCacheMs: number;
  rateLimit: {
    limit: number;
    windowMs: number;
  };
  redisPrefix: string;
  redisMinReplicas: number;
  redisUrl: string;
  redisWaitTimeoutMs: number;
  rpcUrls: Map<number, string>;
  safeAllowlist: Map<number, Set<Address>>;
  safeTargets: SafeTarget[];
  trustProxy: string | number | boolean;
};

type Environment = Record<string, string | undefined>;

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseTrustProxy(value: string | undefined): string | number | boolean {
  if (!value) return false;
  if (value === 'false') return false;
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true is forbidden; configure an exact hop count or proxy IP/CIDR');
  }
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);

  for (const item of value.split(',').map((part) => part.trim())) {
    const [address] = item.split('/');
    if (!isIP(address)) throw new Error(`TRUST_PROXY contains invalid address "${item}"`);
  }

  return value;
}

function parseRpcUrls(raw: string): Map<number, string> {
  const result = new Map<number, string>();

  for (const entry of raw.split(',').map((part) => part.trim())) {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error('RPC_URLS entries must use "<chainId>=<https-url>"');
    }

    const chainId = positiveInteger.parse(entry.slice(0, separator));
    const url = new URL(entry.slice(separator + 1));
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error(`RPC_URLS requires HTTPS outside loopback: ${url.origin}`);
    }
    if (result.has(chainId)) throw new Error(`RPC_URLS contains duplicate chain ${chainId}`);
    result.set(chainId, url.toString());
  }

  return result;
}

function parseSafeTargets(raw: string): {
  allowlist: Map<number, Set<Address>>;
  targets: SafeTarget[];
} {
  const allowlist = new Map<number, Set<Address>>();
  const targets: SafeTarget[] = [];

  for (const entry of raw.split(',').map((part) => part.trim())) {
    const separator = entry.indexOf(':');
    if (separator < 1) throw new Error('SAFE_ALLOWLIST entries must use "<chainId>:<safeAddress>"');

    const chainId = positiveInteger.parse(entry.slice(0, separator));
    const rawAddress = entry.slice(separator + 1);
    if (!isAddress(rawAddress)) throw new Error(`SAFE_ALLOWLIST contains invalid address "${rawAddress}"`);
    const address = getAddress(rawAddress);
    const chainSafes = allowlist.get(chainId) ?? new Set<Address>();
    const isNewTarget = !chainSafes.has(address);
    chainSafes.add(address);
    allowlist.set(chainId, chainSafes);
    if (isNewTarget) targets.push({ chainId, address });
  }

  return { allowlist, targets };
}

function parseCorsOrigins(raw: string): Set<string> {
  const origins = new Set<string>();
  for (const entry of raw.split(',').map((part) => part.trim())) {
    const url = new URL(entry);
    if (url.origin !== entry.replace(/\/$/, '')) {
      throw new Error(`CORS_ORIGINS must contain origins without paths: "${entry}"`);
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      throw new Error(`CORS_ORIGINS requires HTTPS outside loopback: ${url.origin}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function loadConfig(env: Environment = process.env): AppConfig {
  if (env.PILOT_MODE !== undefined) {
    throw new Error('PILOT_MODE is unsupported; configure ADMISSION_MODE=safe-owner explicitly');
  }
  const configuredAdmissionMode = admissionMode.parse(required(env, 'ADMISSION_MODE'));
  const rpcUrls = parseRpcUrls(required(env, 'RPC_URLS'));
  if (rpcUrls.size !== 1 || !rpcUrls.has(REYA_CHAIN_ID)) {
    throw new Error(`RPC_URLS must contain exactly one endpoint for Reya Network chain ${REYA_CHAIN_ID}`);
  }
  const { allowlist: safeAllowlist, targets: safeTargets } = parseSafeTargets(required(env, 'SAFE_ALLOWLIST'));
  if (safeTargets.length !== 1) {
    throw new Error('SAFE_ALLOWLIST must contain exactly one Safe per deployment until Safe-scoped roles are implemented');
  }
  if (safeTargets[0].chainId !== REYA_CHAIN_ID) {
    throw new Error(`SAFE_ALLOWLIST must contain one Safe on Reya Network chain ${REYA_CHAIN_ID}`);
  }

  for (const { chainId } of safeTargets) {
    if (!rpcUrls.has(chainId)) throw new Error(`SAFE_ALLOWLIST chain ${chainId} has no explicit RPC_URLS entry`);
  }

  const proxySecret = required(env, 'AUTH_PROXY_SECRET');
  if (Buffer.byteLength(proxySecret) < 32) {
    throw new Error('AUTH_PROXY_SECRET must contain at least 32 bytes');
  }

  const proposalTtlSeconds = positiveInteger.max(7 * 24 * 60 * 60).parse(env.PROPOSAL_TTL_SECONDS ?? '86400');
  const historyRetentionSeconds = positiveInteger
    .min(60 * 60)
    .max(365 * 24 * 60 * 60)
    .parse(env.HISTORY_RETENTION_SECONDS ?? String(30 * 24 * 60 * 60));
  if (historyRetentionSeconds <= proposalTtlSeconds) {
    throw new Error('HISTORY_RETENTION_SECONDS must be greater than PROPOSAL_TTL_SECONDS');
  }
  const redisBasePrefix = z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-zA-Z0-9:_-]+$/)
    .parse(env.REDIS_PREFIX ?? 'safe-app-backend:v2');

  return {
    admissionMode: configuredAdmissionMode,
    auditMaxLength: positiveInteger.max(1_000_000).parse(env.AUDIT_MAX_LENGTH ?? '100000'),
    auth: {
      identityHeader: headerName.parse(env.AUTH_IDENTITY_HEADER ?? 'x-reya-user'),
      proxySecret,
      proxySecretHeader: headerName.parse(env.AUTH_PROXY_SECRET_HEADER ?? 'x-reya-proxy-secret'),
      rolesHeader: headerName.parse(env.AUTH_ROLES_HEADER ?? 'x-reya-roles'),
    },
    bodyLimit: env.BODY_LIMIT ?? '1mb',
    corsOrigins: parseCorsOrigins(required(env, 'CORS_ORIGINS')),
    historyRetentionMs: historyRetentionSeconds * 1000,
    maxBlockAgeSeconds: positiveInteger.max(3600).parse(env.MAX_BLOCK_AGE_SECONDS ?? '120'),
    maxProposalsPerNonce: positiveInteger.max(100).parse(env.MAX_PROPOSALS_PER_NONCE ?? '20'),
    port: positiveInteger.max(65535).parse(env.PORT ?? '8080'),
    proposalTtlMs: proposalTtlSeconds * 1000,
    readinessCacheMs: positiveInteger.max(60_000).parse(env.READINESS_CACHE_MS ?? '5000'),
    rateLimit: {
      limit: positiveInteger.max(10_000).parse(env.RATE_LIMIT ?? '120'),
      windowMs: positiveInteger.max(60 * 60 * 1000).parse(env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    },
    redisPrefix: `${redisBasePrefix}:admission:${configuredAdmissionMode}:v1`,
    redisMinReplicas: nonnegativeInteger.max(5).parse(env.REDIS_MIN_REPLICAS ?? '1'),
    redisUrl: required(env, 'REDIS_URL'),
    redisWaitTimeoutMs: positiveInteger.max(30_000).parse(env.REDIS_WAIT_TIMEOUT_MS ?? '2000'),
    rpcUrls,
    safeAllowlist,
    safeTargets,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
