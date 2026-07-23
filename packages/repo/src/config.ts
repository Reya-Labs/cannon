import { bool, CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, makeValidator, num, str } from 'envalid';

const nonEmptyStr = makeValidator<string>((input) => {
  if (!input.trim()) {
    throw new EnvError('Value must not be empty');
  }

  return input;
});

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
  REDIS_URL: str({ devDefault: 'redis://localhost:6379' }),
  S3_ENDPOINT: str({ devDefault: '' }),
  S3_BUCKET: str({ devDefault: 'cannon' }),
  S3_FOLDER: str({ devDefault: 'repo-v2' }),
  S3_REGION: str({ devDefault: 'us-east-1' }),
  S3_READ_KEY: nonEmptyStr(),
  S3_READ_SECRET: nonEmptyStr(),
  S3_WRITE_KEY: nonEmptyStr(),
  S3_WRITE_SECRET: nonEmptyStr(),
  API_TOKEN_SECRET: str({ devDefault: 'development-secret-key' }),
};

export type Config = Omit<CleanedEnv<typeof configSpecs>, keyof CleanedEnvAccessors>;

export function loadConfig(environment: unknown) {
  const config = cleanEnv(environment, configSpecs);

  if ((config.NODE_ENV === 'production' || config.NODE_ENV === 'staging') && config.S3_READ_KEY === config.S3_WRITE_KEY) {
    throw new EnvError('S3_READ_KEY and S3_WRITE_KEY must identify different object-storage credentials');
  }

  return config;
}
