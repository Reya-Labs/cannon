/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

    assert.throws(() => loadRegistryConfig(environment), /MAINNET_PROVIDER_URL/);
  });

  it('accepts distinct explicit HTTPS and WSS production RPC endpoints', () => {
    const config = loadRegistryConfig(validRegistryEnvironment());

    assert.equal(config.MAINNET_PROVIDER_URL, 'https://mainnet.example.com/rpc');
    assert.equal(config.OPTIMISM_PROVIDER_URL, 'wss://optimism.example.com/rpc');
  });

  it('returns canonical provider URLs for transport selection', () => {
    const config = loadRegistryConfig({
      ...validRegistryEnvironment(),
      MAINNET_PROVIDER_URL: 'HTTPS://mainnet.example.com/rpc',
      OPTIMISM_PROVIDER_URL: 'WSS://optimism.example.com/rpc',
    });

    assert.equal(config.MAINNET_PROVIDER_URL, 'https://mainnet.example.com/rpc');
    assert.equal(config.OPTIMISM_PROVIDER_URL, 'wss://optimism.example.com/rpc');
  });

  for (const nodeEnvironment of ['production', 'staging'] as const) {
    for (const [providerUrl, expectedError] of [
      ['http://mainnet.example.com', 'non-loopback HTTPS or WSS'],
      ['https://user:secret@mainnet.example.com', 'non-loopback HTTPS or WSS'],
      ['https://mainnet.example.com/rpc#fragment', 'non-loopback HTTPS or WSS'],
      ['https://127.0.0.1:8545', 'non-loopback HTTPS or WSS'],
      ['https://127.0.0.2:8545', 'non-loopback HTTPS or WSS'],
      ['https://0.0.0.0:8545', 'non-loopback HTTPS or WSS'],
      ['https://[::]:8545', 'non-loopback HTTPS or WSS'],
      ['https://[::ffff:127.0.0.1]:8545', 'non-loopback HTTPS or WSS'],
      ['https://service.localhost:8545', 'non-loopback HTTPS or WSS'],
    ] as const) {
      it(`rejects unsafe ${nodeEnvironment} RPC URL ${providerUrl}`, () => {
        assert.throws(
          () =>
            loadRegistryConfig({
              ...validRegistryEnvironment(),
              MAINNET_PROVIDER_URL: providerUrl,
              NODE_ENV: nodeEnvironment,
            }),
          new RegExp(expectedError)
        );
      });
    }
  }

  it('permits explicit loopback RPCs in development', () => {
    const config = loadRegistryConfig({
      ...validRegistryEnvironment(),
      MAINNET_PROVIDER_URL: 'http://127.0.0.1:8545',
      NODE_ENV: 'development',
      OPTIMISM_PROVIDER_URL: 'ws://127.0.0.1:9545',
    });

    assert.equal(config.MAINNET_PROVIDER_URL, 'http://127.0.0.1:8545/');
  });

  it('rejects equivalent production endpoints after URL normalization', () => {
    assert.throws(
      () =>
        loadRegistryConfig({
          ...validRegistryEnvironment(),
          MAINNET_PROVIDER_URL: 'https://rpc.example.com',
          OPTIMISM_PROVIDER_URL: 'https://rpc.example.com/',
        }),
      /must be distinct/
    );
  });
});

describe('4byte configuration', () => {
  it('is disabled by default without requiring network or Redis configuration', () => {
    const config = loadFourByteConfig({});
    assert.deepEqual(
      {
        baseUrl: config.baseUrl,
        enabled: config.enabled,
        redisUrl: config.redisUrl,
      },
      { baseUrl: '', enabled: false, redisUrl: '' }
    );
  });

  it('requires an explicit HTTPS origin and Redis URL when enabled', () => {
    assert.throws(() => loadFourByteConfig({ FOURBYTE_ENABLED: 'true' }), /FOURBYTE_REDIS_URL/);
    assert.throws(
      () =>
        loadFourByteConfig({
          FOURBYTE_BASE_URL: 'http://www.4byte.directory',
          FOURBYTE_ENABLED: 'true',
          FOURBYTE_REDIS_URL: 'redis://localhost:6379',
        }),
      /HTTPS origin/
    );
  });

  it('rejects path-bearing and credential-bearing origins', () => {
    for (const baseUrl of [
      'https://www.4byte.directory/api',
      'https://user:secret@www.4byte.directory',
      'https://www.4byte.directory/?query=true',
    ]) {
      assert.throws(
        () =>
          loadFourByteConfig({
            FOURBYTE_BASE_URL: baseUrl,
            FOURBYTE_ENABLED: 'true',
            FOURBYTE_REDIS_URL: 'rediss://redis.example.com',
          }),
        /HTTPS origin/
      );
    }
  });

  it('rejects loopback and unspecified enrichment origins', () => {
    for (const baseUrl of [
      'https://localhost',
      'https://service.localhost',
      'https://127.0.0.1',
      'https://0.0.0.0',
      'https://[::]',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
    ]) {
      assert.throws(
        () =>
          loadFourByteConfig({
            FOURBYTE_BASE_URL: baseUrl,
            FOURBYTE_ENABLED: 'true',
            FOURBYTE_REDIS_URL: 'rediss://redis.example.com',
          }),
        /non-loopback HTTPS origin/
      );
    }
  });

  it('enforces integer resource bounds', () => {
    assert.throws(
      () =>
        loadFourByteConfig({
          FOURBYTE_BASE_URL: 'https://www.4byte.directory',
          FOURBYTE_ENABLED: 'true',
          FOURBYTE_MAX_PAGES_PER_FEED: '0',
          FOURBYTE_REDIS_URL: 'redis://localhost:6379',
        }),
      /FOURBYTE_MAX_PAGES_PER_FEED/
    );

    assert.throws(
      () =>
        loadFourByteConfig({
          FOURBYTE_BASE_URL: 'https://www.4byte.directory',
          FOURBYTE_ENABLED: 'true',
          FOURBYTE_REDIS_URL: 'redis://localhost:6379',
          FOURBYTE_RETRY_BASE_MS: '100',
          FOURBYTE_RETRY_MAX_MS: '99',
        }),
      /FOURBYTE_RETRY_MAX_MS/
    );
  });
});
