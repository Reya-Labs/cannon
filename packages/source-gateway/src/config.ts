import { isIP } from 'node:net';

const HEADER_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

export type AppConfig = {
  auth: {
    identityHeader: string;
    proxySecret: string;
    proxySecretHeader: string;
  };
  port: number;
  rateLimit: {
    limit: number;
    windowMs: number;
  };
  trustProxy: string | number | boolean;
  uiOrigin: string;
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
  const isProductionOrigin = parsed.protocol === 'https:' && parsed.port === '';
  const isLocalOrigin = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '';
  if (
    (!isProductionOrigin && !isLocalOrigin) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    value !== parsed.origin
  ) {
    throw new Error('SOURCE_UI_ORIGIN must be one canonical HTTPS or 127.0.0.1 HTTP origin');
  }
  return parsed.origin;
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

  return {
    auth: {
      identityHeader,
      proxySecret,
      proxySecretHeader,
    },
    port: positiveInteger(env.PORT ?? '8080', 'PORT', 65_535),
    rateLimit: {
      limit: positiveInteger(env.RATE_LIMIT ?? '60', 'RATE_LIMIT', 10_000),
      windowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS ?? '60000', 'RATE_LIMIT_WINDOW_MS', 3_600_000),
    },
    trustProxy: trustProxy(env.TRUST_PROXY),
    uiOrigin: origin(required(env, 'SOURCE_UI_ORIGIN')),
  };
}
