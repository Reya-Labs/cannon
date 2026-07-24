import { bool, CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, num, str } from 'envalid';

const configSpecs = {
  NODE_ENV: str({
    choices: ['development', 'test', 'production', 'staging'],
    devDefault: 'development',
    default: 'production',
  }),
  PORT: str({ default: '8081' }),
  TRUST_PROXY: bool({ devDefault: true, default: false }),
  RATE_LIMIT_WINDOW: num({ default: 10 * 1000 }),
  RATE_LIMIT_MAX: num({ default: 50 }),
  MEMORY_CACHE: num({ default: 10_000 }),
  MAX_ARTIFACT_BYTES: num({ default: 50 * 1024 * 1024 }),
  CORS_ALLOWED_ORIGINS: str({ devDefault: '', default: '' }),
  REPO_ROLE: str({ choices: ['reader', 'writer', 'combined'], devDefault: 'combined', default: 'combined' }),
  OBJECT_STORE_PROVIDER: str({ choices: ['s3', 'gcs'], devDefault: 's3', default: 's3' }),
  REDIS_URL: str({ devDefault: 'redis://localhost:6379', default: '' }),
  S3_ENDPOINT: str({ devDefault: '', default: '' }),
  S3_BUCKET: str({ devDefault: 'cannon', default: '' }),
  S3_FOLDER: str({ devDefault: 'repo-v2', default: '' }),
  S3_REGION: str({ devDefault: 'us-east-1', default: '' }),
  S3_READ_KEY: str({ devDefault: '', default: '' }),
  S3_READ_SECRET: str({ devDefault: '', default: '' }),
  S3_WRITE_KEY: str({ devDefault: '', default: '' }),
  S3_WRITE_SECRET: str({ devDefault: '', default: '' }),
  GCS_PROJECT_ID: str({ devDefault: '', default: '' }),
  GCS_BUCKET: str({ devDefault: '', default: '' }),
  GCS_FOLDER: str({ devDefault: 'repo-v2', default: '' }),
  API_TOKEN_SECRET: str({ devDefault: 'development-secret-key', default: '' }),
};

export type Config = Omit<CleanedEnv<typeof configSpecs>, keyof CleanedEnvAccessors>;

export function loadConfig(environment: unknown) {
  const config = cleanEnv(environment, configSpecs);
  const productionLike = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';
  const readerEnabled = config.REPO_ROLE === 'reader' || config.REPO_ROLE === 'combined';
  const writerEnabled = config.REPO_ROLE === 'writer' || config.REPO_ROLE === 'combined';
  const corsAllowedOrigins = config.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  function requireValues(values: Array<[string, string]>) {
    for (const [name, value] of values) {
      if (!value.trim()) {
        throw new EnvError(`${name} must not be empty`);
      }
    }
  }

  if (writerEnabled) {
    requireValues([
      ['REDIS_URL', config.REDIS_URL],
      ['API_TOKEN_SECRET', config.API_TOKEN_SECRET],
    ]);
  }

  for (const origin of corsAllowedOrigins) {
    if (origin === '*') {
      throw new EnvError('CORS_ALLOWED_ORIGINS must not contain a wildcard');
    }

    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new EnvError(`CORS_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }

    if (
      parsedOrigin.origin !== origin ||
      !['http:', 'https:'].includes(parsedOrigin.protocol) ||
      (productionLike && parsedOrigin.protocol !== 'https:')
    ) {
      throw new EnvError(`CORS_ALLOWED_ORIGINS must contain exact HTTPS origins in production: ${origin}`);
    }
  }

  if (config.OBJECT_STORE_PROVIDER === 'gcs') {
    requireValues([
      ['GCS_BUCKET', config.GCS_BUCKET],
      ['GCS_FOLDER', config.GCS_FOLDER],
    ]);

    if (productionLike && config.REPO_ROLE === 'combined') {
      throw new EnvError('GCS production and staging workloads must use separate reader or writer roles');
    }
  } else {
    requireValues([
      ['S3_ENDPOINT', config.S3_ENDPOINT],
      ['S3_BUCKET', config.S3_BUCKET],
      ['S3_FOLDER', config.S3_FOLDER],
      ['S3_REGION', config.S3_REGION],
    ]);

    if (readerEnabled) {
      requireValues([
        ['S3_READ_KEY', config.S3_READ_KEY],
        ['S3_READ_SECRET', config.S3_READ_SECRET],
      ]);
    }

    if (writerEnabled) {
      requireValues([
        ['S3_WRITE_KEY', config.S3_WRITE_KEY],
        ['S3_WRITE_SECRET', config.S3_WRITE_SECRET],
      ]);
    }

    if (productionLike && config.REPO_ROLE === 'combined' && config.S3_READ_KEY === config.S3_WRITE_KEY) {
      throw new EnvError('S3_READ_KEY and S3_WRITE_KEY must identify different object-storage credentials');
    }
  }

  return config;
}
