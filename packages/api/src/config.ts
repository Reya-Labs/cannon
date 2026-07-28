import { isIP } from 'node:net';
import 'dotenv/config';

export type NodeEnvironment = 'development' | 'test' | 'production' | 'staging';
export type TrustProxy = false | number | string;

export type ApiConfig = Readonly<{
  CORS_ORIGINS: ReadonlySet<string>;
  METRICS_PASSWORD: string;
  METRICS_USER: string;
  NODE_ENV: NodeEnvironment;
  PORT: number;
  READINESS_CACHE_MS: number;
  READINESS_TIMEOUT_MS: number;
  REDIS_URL: string;
  TRUST_PROXY: TrustProxy;
}>;

type Environment = Record<string, string | undefined>;

function required(environment: Environment, name: string, fallback?: string): string {
  const value = environment[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseInteger(name: string, value: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnvironment = value?.trim() || 'production';
  if (!['development', 'test', 'production', 'staging'].includes(nodeEnvironment)) {
    throw new Error('NODE_ENV must be one of development, test, production or staging');
  }
  return nodeEnvironment as NodeEnvironment;
}

function parseRedisUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL');
  }
  if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.hash) {
    throw new Error('REDIS_URL must be a valid redis:// or rediss:// URL');
  }
  return url.toString();
}

function parseTrustProxy(value: string | undefined, developmentLike: boolean): TrustProxy {
  const normalized = value?.trim();
  if (!normalized || normalized === 'false') return false;
  if (normalized === 'true') {
    throw new Error('TRUST_PROXY=true is forbidden; configure an exact hop count or proxy IP/CIDR');
  }
  if (/^[0-9]+$/.test(normalized)) {
    if (!developmentLike) {
      throw new Error('numeric TRUST_PROXY is allowed only in development and test; use an exact proxy IP/CIDR');
    }
    return parseInteger('TRUST_PROXY', normalized, 1, 10);
  }

  const entries = normalized.split(',').map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry)) {
    throw new Error('TRUST_PROXY must contain an exact hop count or comma-separated proxy IP/CIDR values');
  }
  for (const entry of entries) {
    const [address, prefix, ...extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra.length) throw new Error(`TRUST_PROXY contains invalid address or CIDR "${entry}"`);
    if (prefix !== undefined) {
      const maximumPrefix = family === 4 ? 32 : 128;
      if (!/^[0-9]+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maximumPrefix) {
        throw new Error(`TRUST_PROXY contains invalid address or CIDR "${entry}"`);
      }
    }
  }
  return entries.join(',');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    (isIP(normalized) === 4 && normalized.split('.')[0] === '127')
  );
}

function parseCorsOrigins(raw: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (!entry || entry === '*') throw new Error('CORS_ORIGINS must contain explicit origins, never wildcards');

    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ORIGINS contains invalid origin "${entry}"`);
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.origin !== entry.replace(/\/$/, '')
    ) {
      throw new Error(`CORS_ORIGINS must contain origins without credentials, paths, queries or fragments: "${entry}"`);
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
      throw new Error(`CORS_ORIGINS requires HTTPS outside loopback: ${url.origin}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

export function loadConfig(environment: Environment = process.env): ApiConfig {
  const nodeEnvironment = parseNodeEnvironment(environment.NODE_ENV);
  const developmentLike = nodeEnvironment === 'development' || nodeEnvironment === 'test';
  const metricsUser = required(environment, 'METRICS_USER', developmentLike ? 'admin' : undefined);
  const metricsPassword = required(environment, 'METRICS_PASSWORD', developmentLike ? 'admin' : undefined);
  if (!developmentLike && Buffer.byteLength(metricsPassword) < 16) {
    throw new Error('METRICS_PASSWORD must contain at least 16 bytes outside development and test');
  }

  return Object.freeze({
    CORS_ORIGINS: parseCorsOrigins(
      required(environment, 'CORS_ORIGINS', developmentLike ? 'http://localhost:3000' : undefined)
    ),
    METRICS_PASSWORD: metricsPassword,
    METRICS_USER: metricsUser,
    NODE_ENV: nodeEnvironment,
    PORT: parseInteger('PORT', environment.PORT?.trim() || '8080', 1, 65_535),
    READINESS_CACHE_MS: parseInteger('READINESS_CACHE_MS', environment.READINESS_CACHE_MS?.trim() || '5000', 10, 60_000),
    READINESS_TIMEOUT_MS: parseInteger(
      'READINESS_TIMEOUT_MS',
      environment.READINESS_TIMEOUT_MS?.trim() || '2000',
      10,
      30_000
    ),
    REDIS_URL: parseRedisUrl(required(environment, 'REDIS_URL', developmentLike ? 'redis://localhost:6379' : undefined)),
    TRUST_PROXY: parseTrustProxy(environment.TRUST_PROXY, developmentLike),
  });
}

export const config = loadConfig(process.env);
