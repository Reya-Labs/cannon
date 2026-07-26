import { describe, expect, it } from 'vitest';
import { loadFourByteConfig } from '../src/4byte-config';
import { loadRegistryConfig } from '../src/config';

function validRegistryEnvironment(): Record<string, string> {
  return {
    IPFS_URL: 'https://artifacts.example.com',
    MAINNET_PROVIDER_URL: 'https://mainnet.example.com/rpc',
    NODE_ENV: 'production',
    OPTIMISM_PROVIDER_URL: 'wss://optimism.example.com/rpc',
    REDIS_URL: 'rediss://redis.example.com:6379',
    S3_BUCKET: 'cannon',
    S3_ENDPOINT: 'https://objects.example.com',
    S3_FOLDER: 'repo-v2',
    S3_KEY: 'read-write-key',
    S3_REGION: 'us-east-1',
    S3_SECRET: 'read-write-secret',
  };
}

describe('registry configuration', () => {
  it('requires explicit production RPC endpoints', () => {
    const environment = validRegistryEnvironment();
    delete environment.MAINNET_PROVIDER_URL;

    expect(() => loadRegistryConfig(environment)).toThrow('MAINNET_PROVIDER_URL');
  });

  it('accepts distinct explicit HTTPS and WSS production RPC endpoints', () => {
    const config = loadRegistryConfig(validRegistryEnvironment());

    expect(config.MAINNET_PROVIDER_URL).toBe('https://mainnet.example.com/rpc');
    expect(config.OPTIMISM_PROVIDER_URL).toBe('wss://optimism.example.com/rpc');
  });

  it.each([
    ['http://mainnet.example.com', 'non-loopback HTTPS or WSS'],
    ['https://user:secret@mainnet.example.com', 'non-loopback HTTPS or WSS'],
    ['https://mainnet.example.com/rpc#fragment', 'non-loopback HTTPS or WSS'],
    ['https://127.0.0.1:8545', 'non-loopback HTTPS or WSS'],
    ['https://127.0.0.2:8545', 'non-loopback HTTPS or WSS'],
    ['https://service.localhost:8545', 'non-loopback HTTPS or WSS'],
  ])('rejects an unsafe production RPC URL %s', (providerUrl, expectedError) => {
    expect(() =>
      loadRegistryConfig({
        ...validRegistryEnvironment(),
        MAINNET_PROVIDER_URL: providerUrl,
      })
    ).toThrow(expectedError);
  });

  it('permits explicit loopback RPCs in development', () => {
    const config = loadRegistryConfig({
      ...validRegistryEnvironment(),
      MAINNET_PROVIDER_URL: 'http://127.0.0.1:8545',
      NODE_ENV: 'development',
      OPTIMISM_PROVIDER_URL: 'ws://127.0.0.1:9545',
    });

    expect(config.MAINNET_PROVIDER_URL).toBe('http://127.0.0.1:8545');
  });

  it('rejects equivalent production endpoints after URL normalization', () => {
    expect(() =>
      loadRegistryConfig({
        ...validRegistryEnvironment(),
        MAINNET_PROVIDER_URL: 'https://rpc.example.com',
        OPTIMISM_PROVIDER_URL: 'https://rpc.example.com/',
      })
    ).toThrow('must be distinct');
  });
});

describe('4byte configuration', () => {
  it('is disabled by default without requiring network or Redis configuration', () => {
    expect(loadFourByteConfig({})).toMatchObject({
      baseUrl: '',
      enabled: false,
      redisUrl: '',
    });
  });

  it('requires an explicit HTTPS origin and Redis URL when enabled', () => {
    expect(() => loadFourByteConfig({ FOURBYTE_ENABLED: 'true' })).toThrow('FOURBYTE_REDIS_URL');
    expect(() =>
      loadFourByteConfig({
        FOURBYTE_BASE_URL: 'http://www.4byte.directory',
        FOURBYTE_ENABLED: 'true',
        FOURBYTE_REDIS_URL: 'redis://localhost:6379',
      })
    ).toThrow('HTTPS origin');
  });

  it('rejects path-bearing and credential-bearing origins', () => {
    for (const baseUrl of [
      'https://www.4byte.directory/api',
      'https://user:secret@www.4byte.directory',
      'https://www.4byte.directory/?query=true',
    ]) {
      expect(() =>
        loadFourByteConfig({
          FOURBYTE_BASE_URL: baseUrl,
          FOURBYTE_ENABLED: 'true',
          FOURBYTE_REDIS_URL: 'rediss://redis.example.com',
        })
      ).toThrow('HTTPS origin');
    }
  });

  it('enforces integer resource bounds', () => {
    expect(() =>
      loadFourByteConfig({
        FOURBYTE_BASE_URL: 'https://www.4byte.directory',
        FOURBYTE_ENABLED: 'true',
        FOURBYTE_MAX_PAGES_PER_FEED: '0',
        FOURBYTE_REDIS_URL: 'redis://localhost:6379',
      })
    ).toThrow('FOURBYTE_MAX_PAGES_PER_FEED');

    expect(() =>
      loadFourByteConfig({
        FOURBYTE_BASE_URL: 'https://www.4byte.directory',
        FOURBYTE_ENABLED: 'true',
        FOURBYTE_REDIS_URL: 'redis://localhost:6379',
        FOURBYTE_RETRY_BASE_MS: '100',
        FOURBYTE_RETRY_MAX_MS: '99',
      })
    ).toThrow('FOURBYTE_RETRY_MAX_MS');
  });
});
