import { isIP } from 'node:net';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEADER_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

export type AppConfig = {
  auth: {
    identityHeader: string;
    proxySecret: string;
    proxySecretHeader: string;
  };
  limits: {
    bodyBytes: number;
    calldataBytes: number;
    concurrency: number;
    queue: number;
    rateLimit: number;
    rateLimitWindowMs: number;
    responseBytes: number;
  };
  port: number;
  quorum: {
    maxBlockAgeSeconds: number;
    maxFutureSkewSeconds: number;
    maxHeadLagBlocks: number;
    snapshotTtlMs: number;
    timeoutMs: number;
  };
  safeAddress: string;
  trustProxy: string | number | boolean;
  uiOrigin: string;
  upstreams: readonly [URL, URL];
};

type Environment = Record<string, string | undefined>;

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(value: string, key: string, maximum: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${key} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${key} is outside the supported range`);
  }
  return parsed;
}

function header(value: string | undefined, fallback: string, key: string): string {
  const parsed = (value ?? fallback).toLowerCase();
  if (!HEADER_PATTERN.test(parsed)) throw new Error(`${key} is not a valid HTTP header name`);
  return parsed;
}

function trustProxy(value: string | undefined): string | number | boolean {
  if (!value || value === 'false') return false;
  if (value === 'true') {
    throw new Error('TRUST_PROXY=true is forbidden; configure an exact hop count or proxy IP/CIDR');
  }
  if (/^[1-9][0-9]*$/.test(value)) return positiveInteger(value, 'TRUST_PROXY', 16);
  for (const item of value.split(',').map((part) => part.trim())) {
    const pieces = item.split('/');
    if (pieces.length > 2) throw new Error(`TRUST_PROXY contains invalid address "${item}"`);
    const [address, prefix] = pieces;
    const family = isIP(address);
    if (!family) throw new Error(`TRUST_PROXY contains invalid address "${item}"`);
    if (prefix !== undefined) {
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefix)) {
        throw new Error(`TRUST_PROXY contains invalid address "${item}"`);
      }
      const parsed = Number(prefix);
      if (parsed > (family === 4 ? 32 : 128)) {
        throw new Error(`TRUST_PROXY contains invalid address "${item}"`);
      }
    }
  }
  return value;
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    throw new Error('RPC_UI_ORIGIN must be one canonical HTTPS origin');
  }
  return parsed.origin;
}

function upstreams(value: string): readonly [URL, URL] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error('RPC_UPSTREAM_URLS_JSON must be valid JSON');
  }
  if (!Array.isArray(decoded) || decoded.length !== 2 || !decoded.every((item) => typeof item === 'string')) {
    throw new Error('RPC_UPSTREAM_URLS_JSON must contain exactly two URL strings');
  }
  const parsed = decoded.map((item) => new URL(item));
  for (const url of parsed) {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.port ||
      isIP(url.hostname)
    ) {
      throw new Error('RPC upstreams must be canonical HTTPS URLs without credentials, query, fragment, port, or IP host');
    }
  }
  if (parsed[0].hostname === parsed[1].hostname) {
    throw new Error('RPC upstreams must use two distinct provider hostnames');
  }
  return parsed as [URL, URL];
}

export function loadConfig(env: Environment = process.env): AppConfig {
  const proxySecret = required(env, 'AUTH_PROXY_SECRET');
  if (Buffer.byteLength(proxySecret) < 32) {
    throw new Error('AUTH_PROXY_SECRET must contain at least 32 bytes');
  }
  const identityHeader = header(env.AUTH_IDENTITY_HEADER, 'x-reya-user', 'AUTH_IDENTITY_HEADER');
  const proxySecretHeader = header(env.AUTH_PROXY_SECRET_HEADER, 'x-reya-proxy-secret', 'AUTH_PROXY_SECRET_HEADER');
  if (identityHeader === proxySecretHeader) {
    throw new Error('AUTH_IDENTITY_HEADER and AUTH_PROXY_SECRET_HEADER must be different');
  }
  const safeAddress = required(env, 'SAFE_ADDRESS');
  if (!ADDRESS_PATTERN.test(safeAddress) || /^0x0{40}$/i.test(safeAddress)) {
    throw new Error('SAFE_ADDRESS must be a non-zero EVM address');
  }

  return {
    auth: { identityHeader, proxySecret, proxySecretHeader },
    limits: {
      bodyBytes: positiveInteger(env.BODY_BYTES ?? '131072', 'BODY_BYTES', 1_048_576),
      calldataBytes: positiveInteger(env.CALLDATA_BYTES ?? '65536', 'CALLDATA_BYTES', 262_144),
      concurrency: positiveInteger(env.CONCURRENCY ?? '16', 'CONCURRENCY', 128),
      queue: positiveInteger(env.QUEUE ?? '64', 'QUEUE', 512),
      rateLimit: positiveInteger(env.RATE_LIMIT ?? '60', 'RATE_LIMIT', 10_000),
      rateLimitWindowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS ?? '60000', 'RATE_LIMIT_WINDOW_MS', 3_600_000),
      responseBytes: positiveInteger(env.RESPONSE_BYTES ?? '2097152', 'RESPONSE_BYTES', 8_388_608),
    },
    port: positiveInteger(env.PORT ?? '8080', 'PORT', 65_535),
    quorum: {
      maxBlockAgeSeconds: positiveInteger(env.MAX_BLOCK_AGE_SECONDS ?? '120', 'MAX_BLOCK_AGE_SECONDS', 3600),
      maxFutureSkewSeconds: positiveInteger(env.MAX_FUTURE_SKEW_SECONDS ?? '30', 'MAX_FUTURE_SKEW_SECONDS', 300),
      maxHeadLagBlocks: positiveInteger(env.MAX_HEAD_LAG_BLOCKS ?? '2', 'MAX_HEAD_LAG_BLOCKS', 32),
      snapshotTtlMs: positiveInteger(env.SNAPSHOT_TTL_MS ?? '10000', 'SNAPSHOT_TTL_MS', 60_000),
      timeoutMs: positiveInteger(env.UPSTREAM_TIMEOUT_MS ?? '8000', 'UPSTREAM_TIMEOUT_MS', 30_000),
    },
    safeAddress: safeAddress.toLowerCase(),
    trustProxy: trustProxy(env.TRUST_PROXY),
    uiOrigin: origin(required(env, 'RPC_UI_ORIGIN')),
    upstreams: upstreams(required(env, 'RPC_UPSTREAM_URLS_JSON')),
  };
}
