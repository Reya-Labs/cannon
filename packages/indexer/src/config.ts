import { CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, str } from 'envalid';
import 'dotenv/config';
import { loadQueueConfig } from './queue-config';
import type { QueueConfig } from './queue-config';

const registryConfigSpecs = {
  NODE_ENV: str({
    choices: ['development', 'test', 'production', 'staging'],
    default: 'production',
    devDefault: 'development',
  }),
  IPFS_URL: str({ devDefault: 'http://127.0.0.1:5001' }),
  NOTIFY_PKGS: str({ default: '' }),
  MAINNET_PROVIDER_URL: str({ default: '', devDefault: 'http://127.0.0.1:8545' }),
  OPTIMISM_PROVIDER_URL: str({ default: '', devDefault: 'http://127.0.0.1:9545' }),
};

type RegistrySpecificConfig = Omit<CleanedEnv<typeof registryConfigSpecs>, keyof CleanedEnvAccessors>;
export type RegistryConfig = RegistrySpecificConfig & QueueConfig;

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
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === '::' ||
    hostname === '::1' ||
    hostname === '::ffff:0:0' ||
    hostname.startsWith('127.') ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(hostname);
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

  return Object.freeze({
    ...config,
    ...loadQueueConfig(environment),
    MAINNET_PROVIDER_URL: mainnetProviderUrl,
    OPTIMISM_PROVIDER_URL: optimismProviderUrl,
  }) as RegistryConfig;
}

export const config = loadRegistryConfig(process.env);
