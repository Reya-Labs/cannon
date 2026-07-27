/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadFourByteConfig } from '../src/4byte-config';
import { loadRegistryConfig } from '../src/config';
import { loadArtifactWorkerConfig } from '../src/worker-config';

function validRegistryEnvironment(): Record<string, string> {
  return {
    IPFS_URL: 'https://artifacts.example.com',
    MAINNET_PROVIDER_URL: 'https://mainnet.example.com/rpc',
    NODE_ENV: 'production',
    OPTIMISM_PROVIDER_URL: 'wss://optimism.example.com/rpc',
    REDIS_URL: 'rediss://redis.example.com:6379',
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

  it('does not require privileged object-storage credentials', () => {
    const config = loadRegistryConfig(validRegistryEnvironment());

    assert.equal('S3_KEY' in config, false);
    assert.equal('S3_SECRET' in config, false);
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
          (error: unknown) => error instanceof Error && error.message.includes(expectedError)
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

describe('artifact worker configuration', () => {
  function validWorkerEnvironment() {
    return {
      ARTIFACT_SOURCE_URL: 'https://artifacts.example.com',
      ARTIFACT_WRITER_TOKEN: 'writer-token',
      ARTIFACT_WRITER_URL: 'https://writer.example.com',
      NODE_ENV: 'production',
      REDIS_URL: 'rediss://redis.example.com:6379',
    };
  }

  it('requires explicit source, authenticated writer, and Redis endpoints without object-store credentials', () => {
    const config = loadArtifactWorkerConfig(validWorkerEnvironment());

    assert.equal(config.ARTIFACT_SOURCE_URL, 'https://artifacts.example.com');
    assert.equal(config.ARTIFACT_WRITER_URL, 'https://writer.example.com');
    assert.equal('S3_KEY' in config, false);
    assert.equal('S3_SECRET' in config, false);
    assert.equal('GCS_PROJECT_ID' in config, false);
  });

  it('fails closed without any required facade setting', () => {
    for (const name of ['ARTIFACT_SOURCE_URL', 'ARTIFACT_WRITER_URL', 'ARTIFACT_WRITER_TOKEN'] as const) {
      const environment: Record<string, string> = validWorkerEnvironment();
      delete environment[name];
      assert.throws(() => loadArtifactWorkerConfig(environment), new RegExp(name));
    }
  });

  it('rejects unsafe production facade endpoints', () => {
    for (const sourceUrl of [
      'http://artifacts.example.com',
      'https://user:secret@artifacts.example.com',
      'https://artifacts.example.com/api',
      'https://127.0.0.1',
      'https://[::ffff:0.0.0.0]',
      'https://[::ffff:127.0.0.1]',
      'https://service.localhost',
      'https://service.localhost.',
    ]) {
      assert.throws(
        () =>
          loadArtifactWorkerConfig({
            ...validWorkerEnvironment(),
            ARTIFACT_SOURCE_URL: sourceUrl,
          }),
        /non-loopback HTTPS/
      );
    }
  });

  it('allows explicit loopback HTTP facades for tests and development', () => {
    const config = loadArtifactWorkerConfig({
      ...validWorkerEnvironment(),
      ARTIFACT_SOURCE_URL: 'http://127.0.0.1:8081',
      ARTIFACT_WRITER_URL: 'http://localhost:8082',
      NODE_ENV: 'test',
    });

    assert.equal(config.ARTIFACT_SOURCE_URL, 'http://127.0.0.1:8081');
    assert.equal(config.ARTIFACT_WRITER_URL, 'http://localhost:8082');
  });

  it('rejects writer tokens with surrounding whitespace', () => {
    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          ARTIFACT_WRITER_TOKEN: ' writer-secret',
        }),
      /surrounding whitespace/
    );
  });

  it('enforces integer and relational resource bounds', () => {
    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          ARTIFACT_MAX_CLOSURE_NODES: '0',
        }),
      /ARTIFACT_MAX_CLOSURE_NODES/
    );
    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          ARTIFACT_MAX_FETCH_BYTES: '10',
          ARTIFACT_MAX_NODE_BYTES: '11',
        }),
      /ARTIFACT_MAX_NODE_BYTES must not exceed/
    );
    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          ARTIFACT_MAX_CLOSURE_INFLATED_BYTES: '100',
          ARTIFACT_MAX_INFLATED_BYTES: '101',
        }),
      /ARTIFACT_MAX_INFLATED_BYTES must not exceed/
    );
    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          ARTIFACT_JOB_TIMEOUT_MS: `${15 * 60_000 + 1}`,
        }),
      /ARTIFACT_JOB_TIMEOUT_MS must not exceed/
    );
  });

  it('admits only the concurrency that fits the configured payload budget', () => {
    const defaults = loadArtifactWorkerConfig(validWorkerEnvironment());
    assert.equal(defaults.QUEUE_CONCURRENCY, 1);
    assert.equal(defaults.ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES, 256 * 1024 * 1024);

    assert.throws(
      () =>
        loadArtifactWorkerConfig({
          ...validWorkerEnvironment(),
          QUEUE_CONCURRENCY: '2',
        }),
      /exceed ARTIFACT_WORKER_PAYLOAD_BUDGET_BYTES/
    );

    const twoSmallJobs = loadArtifactWorkerConfig({
      ...validWorkerEnvironment(),
      ARTIFACT_MAX_CLOSURE_BYTES: `${32 * 1024 * 1024}`,
      ARTIFACT_MAX_COMPRESSED_BYTES: `${8 * 1024 * 1024}`,
      ARTIFACT_MAX_FETCH_BYTES: `${8 * 1024 * 1024}`,
      ARTIFACT_MAX_INFLATED_BYTES: `${16 * 1024 * 1024}`,
      ARTIFACT_MAX_NODE_BYTES: `${8 * 1024 * 1024}`,
      QUEUE_CONCURRENCY: '2',
    });
    assert.equal(twoSmallJobs.QUEUE_CONCURRENCY, 2);
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
