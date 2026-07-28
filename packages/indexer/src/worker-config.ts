import { CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, num, str } from 'envalid';
import 'dotenv/config';
import { loadQueueConfig } from './queue-config';
import type { QueueConfig } from './queue-config';

const MEBIBYTE = 1024 * 1024;
const MAX_ARTIFACT_JOB_TIMEOUT_MS = 15 * 60_000;
const FETCH_TRANSIENT_COPIES = 2;
const INFLATED_TRANSIENT_COPIES = 4;

const artifactWorkerConfigSpecs = {
  NODE_ENV: str({
    choices: ['development', 'test', 'production', 'staging'],
    default: 'production',
    devDefault: 'development',
  }),
  ARTIFACT_SOURCE_URL: str({ default: '' }),
  ARTIFACT_WRITER_URL: str({ default: '' }),
  ARTIFACT_WRITER_TOKEN: str({ default: '' }),
  ARTIFACT_FETCH_TIMEOUT_MS: num({ default: 30_000 }),
  ARTIFACT_WRITE_TIMEOUT_MS: num({ default: 30_000 }),
  ARTIFACT_READINESS_TIMEOUT_MS: num({ default: 10_000 }),
  ARTIFACT_JOB_TIMEOUT_MS: num({ default: 5 * 60_000 }),
  ARTIFACT_MAX_FETCH_BYTES: num({ default: 16 * MEBIBYTE }),
  ARTIFACT_MAX_NODE_BYTES: num({ default: 16 * MEBIBYTE }),
  ARTIFACT_MAX_COMPRESSED_BYTES: num({ default: 16 * MEBIBYTE }),
  ARTIFACT_MAX_INFLATED_BYTES: num({ default: 32 * MEBIBYTE }),
  ARTIFACT_MAX_CLOSURE_BYTES: num({ default: 64 * MEBIBYTE }),
  ARTIFACT_MAX_CLOSURE_INFLATED_BYTES: num({ default: 256 * MEBIBYTE }),
  ARTIFACT_MAX_CLOSURE_NODES: num({ default: 128 }),
  ARTIFACT_MAX_HEALTH_RESPONSE_BYTES: num({ default: 4 * 1024 }),
  ARTIFACT_MAX_WRITE_RESPONSE_BYTES: num({ default: 64 * 1024 }),
  ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES: num({ default: 256 * MEBIBYTE }),
};

type ArtifactWorkerSpecificConfig = Omit<CleanedEnv<typeof artifactWorkerConfigSpecs>, keyof CleanedEnvAccessors>;

export type ArtifactWorkerConfig = ArtifactWorkerSpecificConfig & QueueConfig;

function validateEndpoint(name: string, value: string, productionLike: boolean): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new EnvError(`${name} must be a valid URL`);
  }

  const hostname = endpoint.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  const loopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '::1' ||
    hostname === '::ffff:0:0' ||
    hostname === '::ffff:127.0.0.1' ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(hostname) ||
    hostname.startsWith('127.');

  if (
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password ||
    !['http:', 'https:'].includes(endpoint.protocol) ||
    (productionLike && (endpoint.protocol !== 'https:' || loopback))
  ) {
    throw new EnvError(`${name} must be an explicit ${productionLike ? 'non-loopback HTTPS' : 'HTTP(S)'} origin`);
  }

  return endpoint.origin;
}

function requirePositiveInteger(name: string, value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EnvError(`${name} must be a positive integer`);
  }
}

export function loadArtifactWorkerConfig(environment: unknown = process.env): ArtifactWorkerConfig {
  const config = cleanEnv(environment, artifactWorkerConfigSpecs);
  const queueConfig = loadQueueConfig(environment);
  const productionLike = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';
  const sourceUrl = validateEndpoint('ARTIFACT_SOURCE_URL', config.ARTIFACT_SOURCE_URL, productionLike);
  const writerUrl = validateEndpoint('ARTIFACT_WRITER_URL', config.ARTIFACT_WRITER_URL, productionLike);

  if (sourceUrl === writerUrl) {
    throw new EnvError('ARTIFACT_SOURCE_URL and ARTIFACT_WRITER_URL must be distinct endpoints');
  }

  if (!config.ARTIFACT_WRITER_TOKEN.trim()) {
    throw new EnvError('ARTIFACT_WRITER_TOKEN must be configured explicitly');
  }
  if (config.ARTIFACT_WRITER_TOKEN !== config.ARTIFACT_WRITER_TOKEN.trim()) {
    throw new EnvError('ARTIFACT_WRITER_TOKEN must not contain surrounding whitespace');
  }

  for (const name of [
    'ARTIFACT_FETCH_TIMEOUT_MS',
    'ARTIFACT_WRITE_TIMEOUT_MS',
    'ARTIFACT_READINESS_TIMEOUT_MS',
    'ARTIFACT_JOB_TIMEOUT_MS',
    'ARTIFACT_MAX_FETCH_BYTES',
    'ARTIFACT_MAX_NODE_BYTES',
    'ARTIFACT_MAX_COMPRESSED_BYTES',
    'ARTIFACT_MAX_INFLATED_BYTES',
    'ARTIFACT_MAX_CLOSURE_BYTES',
    'ARTIFACT_MAX_CLOSURE_INFLATED_BYTES',
    'ARTIFACT_MAX_CLOSURE_NODES',
    'ARTIFACT_MAX_HEALTH_RESPONSE_BYTES',
    'ARTIFACT_MAX_WRITE_RESPONSE_BYTES',
    'ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES',
  ] as const) {
    requirePositiveInteger(name, config[name]);
  }
  requirePositiveInteger('QUEUE_CONCURRENCY', queueConfig.QUEUE_CONCURRENCY);
  requirePositiveInteger('QUEUE_RETRIES', queueConfig.QUEUE_RETRIES);

  if (config.ARTIFACT_MAX_NODE_BYTES > config.ARTIFACT_MAX_FETCH_BYTES) {
    throw new EnvError('ARTIFACT_MAX_NODE_BYTES must not exceed ARTIFACT_MAX_FETCH_BYTES');
  }
  if (config.ARTIFACT_MAX_COMPRESSED_BYTES > config.ARTIFACT_MAX_NODE_BYTES) {
    throw new EnvError('ARTIFACT_MAX_COMPRESSED_BYTES must not exceed ARTIFACT_MAX_NODE_BYTES');
  }
  if (config.ARTIFACT_MAX_NODE_BYTES > config.ARTIFACT_MAX_CLOSURE_BYTES) {
    throw new EnvError('ARTIFACT_MAX_NODE_BYTES must not exceed ARTIFACT_MAX_CLOSURE_BYTES');
  }
  if (config.ARTIFACT_MAX_INFLATED_BYTES > config.ARTIFACT_MAX_CLOSURE_INFLATED_BYTES) {
    throw new EnvError('ARTIFACT_MAX_INFLATED_BYTES must not exceed ARTIFACT_MAX_CLOSURE_INFLATED_BYTES');
  }
  if (config.ARTIFACT_JOB_TIMEOUT_MS > MAX_ARTIFACT_JOB_TIMEOUT_MS) {
    throw new EnvError(`ARTIFACT_JOB_TIMEOUT_MS must not exceed ${MAX_ARTIFACT_JOB_TIMEOUT_MS}`);
  }

  // Admission-control estimate: a job retains its compressed closure, may
  // briefly duplicate a maximum response while streaming/forming a request, and may hold an
  // inflated buffer plus its UTF-8/JSON representations. The budget excludes
  // the Node runtime baseline, which still requires container headroom.
  const perJobPayloadBytes =
    config.ARTIFACT_MAX_CLOSURE_BYTES +
    FETCH_TRANSIENT_COPIES * Math.max(config.ARTIFACT_MAX_FETCH_BYTES, config.ARTIFACT_MAX_WRITE_RESPONSE_BYTES) +
    INFLATED_TRANSIENT_COPIES * config.ARTIFACT_MAX_INFLATED_BYTES;
  const activePayloadBytes = perJobPayloadBytes * queueConfig.QUEUE_CONCURRENCY;
  if (
    !Number.isSafeInteger(perJobPayloadBytes) ||
    !Number.isSafeInteger(activePayloadBytes) ||
    activePayloadBytes > config.ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES
  ) {
    throw new EnvError('QUEUE_CONCURRENCY and artifact byte limits exceed ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES');
  }

  return Object.freeze({
    ...config,
    ...queueConfig,
    ARTIFACT_SOURCE_URL: sourceUrl,
    ARTIFACT_WRITER_URL: writerUrl,
  }) as ArtifactWorkerConfig;
}
