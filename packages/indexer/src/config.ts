import { CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, num, str } from 'envalid';
import 'dotenv/config';

const registryConfigSpecs = {
  NODE_ENV: str({
    choices: ['development', 'test', 'production', 'staging'],
    default: 'production',
    devDefault: 'development',
  }),
  IPFS_URL: str({ devDefault: 'http://127.0.0.1:5001' }),
  REDIS_URL: str({ devDefault: 'redis://localhost:6379' }),
  NOTIFY_PKGS: str({ default: '' }),
  MAINNET_PROVIDER_URL: str({ default: '', devDefault: 'http://127.0.0.1:8545' }),
  OPTIMISM_PROVIDER_URL: str({ default: '', devDefault: 'http://127.0.0.1:9545' }),
  QUEUE_NAME: str({ default: 'pinner-queue' }),
  QUEUE_CONCURRENCY: num({ default: 5 }),
  QUEUE_RETRIES: num({ default: 5 }),
  S3_ENDPOINT: str({ devDefault: '' }),
  S3_BUCKET: str({ devDefault: 'cannon' }),
  S3_FOLDER: str({ devDefault: 'repo-v2' }),
  S3_REGION: str({ devDefault: 'us-east-1' }),
  S3_KEY: str({ devDefault: '' }),
  S3_SECRET: str({ devDefault: '' }),
};

export type RegistryConfig = Omit<CleanedEnv<typeof registryConfigSpecs>, keyof CleanedEnvAccessors>;

function validateProviderUrl(name: string, value: string, productionLike: boolean): string {
  if (!value.trim()) {
    throw new EnvError(`${name} must be configured explicitly`);
  }

  let providerUrl: URL;
  try {
    providerUrl = new URL(value);
  } catch {
    throw new EnvError(`${name} must be a valid URL`);
  }

  const hostname = providerUrl.hostname
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
  const loopback =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || hostname.startsWith('127.');
  const permittedProtocol = productionLike
    ? providerUrl.protocol === 'https:' || providerUrl.protocol === 'wss:'
    : ['http:', 'https:', 'ws:', 'wss:'].includes(providerUrl.protocol);

  if (
    !permittedProtocol ||
    providerUrl.username ||
    providerUrl.password ||
    providerUrl.hash ||
    (productionLike && loopback)
  ) {
    throw new EnvError(
      `${name} must be an explicit ${productionLike ? 'non-loopback HTTPS or WSS' : 'HTTP(S) or WS(S)'} endpoint`
    );
  }

  return providerUrl.toString();
}

export function loadRegistryConfig(environment: unknown = process.env): RegistryConfig {
  const config = cleanEnv(environment, registryConfigSpecs);
  const productionLike = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';

  const mainnetProviderUrl = validateProviderUrl('MAINNET_PROVIDER_URL', config.MAINNET_PROVIDER_URL, productionLike);
  const optimismProviderUrl = validateProviderUrl('OPTIMISM_PROVIDER_URL', config.OPTIMISM_PROVIDER_URL, productionLike);

  if (mainnetProviderUrl === optimismProviderUrl) {
    throw new EnvError('MAINNET_PROVIDER_URL and OPTIMISM_PROVIDER_URL must be distinct endpoints');
  }

  return config;
}

export const config = loadRegistryConfig(process.env);
