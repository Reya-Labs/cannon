import { bool, cleanEnv, EnvError, num, str } from 'envalid';

const fourByteConfigSpecs = {
  FOURBYTE_ENABLED: bool({ default: false }),
  FOURBYTE_BASE_URL: str({ default: '' }),
  FOURBYTE_REDIS_URL: str({ default: '' }),
  FOURBYTE_MAX_PAGES_PER_FEED: num({ default: 25 }),
  FOURBYTE_MAX_ENTRIES_PER_RUN: num({ default: 10_000 }),
  FOURBYTE_MAX_RESULTS_PER_PAGE: num({ default: 1_000 }),
  FOURBYTE_MAX_RESPONSE_BYTES: num({ default: 2 * 1024 * 1024 }),
  FOURBYTE_REQUEST_TIMEOUT_MS: num({ default: 10_000 }),
  FOURBYTE_RETRIES: num({ default: 3 }),
  FOURBYTE_RETRY_BASE_MS: num({ default: 250 }),
  FOURBYTE_RETRY_MAX_MS: num({ default: 5_000 }),
};

export type FourByteConfig = {
  baseUrl: string;
  enabled: boolean;
  maxEntriesPerRun: number;
  maxPagesPerFeed: number;
  maxResponseBytes: number;
  maxResultsPerPage: number;
  redisUrl: string;
  requestTimeoutMs: number;
  retries: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EnvError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateBaseUrl(value: string): string {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new EnvError('FOURBYTE_BASE_URL must be a valid URL');
  }

  const hostname = baseUrl.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  const loopbackOrUnspecified =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '::1' ||
    hostname === '::ffff:0:0' ||
    hostname.startsWith('127.') ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(hostname);

  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.username ||
    baseUrl.password ||
    loopbackOrUnspecified
  ) {
    throw new EnvError('FOURBYTE_BASE_URL must be a non-loopback HTTPS origin without credentials, path, query or fragment');
  }

  return baseUrl.origin;
}

export function loadFourByteConfig(environment: unknown = process.env): FourByteConfig {
  const config = cleanEnv(environment, fourByteConfigSpecs);
  const maxPagesPerFeed = boundedInteger('FOURBYTE_MAX_PAGES_PER_FEED', config.FOURBYTE_MAX_PAGES_PER_FEED, 1, 1_000);
  const maxEntriesPerRun = boundedInteger('FOURBYTE_MAX_ENTRIES_PER_RUN', config.FOURBYTE_MAX_ENTRIES_PER_RUN, 1, 100_000);
  const maxResultsPerPage = boundedInteger('FOURBYTE_MAX_RESULTS_PER_PAGE', config.FOURBYTE_MAX_RESULTS_PER_PAGE, 1, 5_000);
  const maxResponseBytes = boundedInteger(
    'FOURBYTE_MAX_RESPONSE_BYTES',
    config.FOURBYTE_MAX_RESPONSE_BYTES,
    1_024,
    16 * 1024 * 1024
  );
  const requestTimeoutMs = boundedInteger('FOURBYTE_REQUEST_TIMEOUT_MS', config.FOURBYTE_REQUEST_TIMEOUT_MS, 100, 60_000);
  const retries = boundedInteger('FOURBYTE_RETRIES', config.FOURBYTE_RETRIES, 0, 10);
  const retryBaseMs = boundedInteger('FOURBYTE_RETRY_BASE_MS', config.FOURBYTE_RETRY_BASE_MS, 1, 10_000);
  const retryMaxMs = boundedInteger('FOURBYTE_RETRY_MAX_MS', config.FOURBYTE_RETRY_MAX_MS, 1, 60_000);
  if (retryMaxMs < retryBaseMs) {
    throw new EnvError('FOURBYTE_RETRY_MAX_MS must be greater than or equal to FOURBYTE_RETRY_BASE_MS');
  }

  if (!config.FOURBYTE_ENABLED) {
    return {
      baseUrl: '',
      enabled: false,
      maxEntriesPerRun,
      maxPagesPerFeed,
      maxResponseBytes,
      maxResultsPerPage,
      redisUrl: '',
      requestTimeoutMs,
      retries,
      retryBaseMs,
      retryMaxMs,
    };
  }

  if (!config.FOURBYTE_REDIS_URL.trim()) {
    throw new EnvError('FOURBYTE_REDIS_URL must be configured when enrichment is enabled');
  }

  let redisUrl: URL;
  try {
    redisUrl = new URL(config.FOURBYTE_REDIS_URL);
  } catch {
    throw new EnvError('FOURBYTE_REDIS_URL must be a valid Redis URL');
  }
  if (!['redis:', 'rediss:'].includes(redisUrl.protocol)) {
    throw new EnvError('FOURBYTE_REDIS_URL must use redis:// or rediss://');
  }

  return {
    baseUrl: validateBaseUrl(config.FOURBYTE_BASE_URL),
    enabled: true,
    maxEntriesPerRun,
    maxPagesPerFeed,
    maxResponseBytes,
    maxResultsPerPage,
    redisUrl: config.FOURBYTE_REDIS_URL,
    requestTimeoutMs,
    retries,
    retryBaseMs,
    retryMaxMs,
  };
}
