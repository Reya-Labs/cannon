/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import type { ApiConfig } from '../src/config';
import { ServiceUnavailableError } from '../src/errors';
import { startServer } from '../src/index';

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    CORS_ORIGINS: new Set(['https://cannon.reya.network']),
    METRICS_PASSWORD: 'a-strong-metrics-password',
    METRICS_USER: 'metrics',
    NODE_ENV: 'test',
    PORT: 0,
    READINESS_CACHE_MS: 10,
    READINESS_TIMEOUT_MS: 10,
    REDIS_URL: 'redis://localhost:6379/',
    TRUST_PROXY: false,
    ...overrides,
  };
}

describe('query API server lifecycle', () => {
  it('binds liveness while background Redis startup is pending and keeps dependent routes closed', async () => {
    let connectCalls = 0;
    let disconnectCalls = 0;
    const runtime = await startServer({
      checkReadiness: async () => {
        throw new ServiceUnavailableError();
      },
      config: config(),
      connectRedis: () => {
        connectCalls += 1;
        return new Promise<void>(() => undefined);
      },
      disconnectRedis: async () => {
        disconnectCalls += 1;
      },
    });

    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(connectCalls, 1);
      const address = runtime.server.address();
      assert.ok(address && typeof address !== 'string');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const live = await fetch(`${baseUrl}/livez`);
      assert.equal(live.status, 200);

      const ready = await fetch(`${baseUrl}/readyz`);
      assert.equal(ready.status, 503);
      assert.deepEqual(await ready.json(), { status: 503, error: 'Service Unavailable' });

      const data = await fetch(`${baseUrl}/chains`);
      assert.equal(data.status, 503);
      assert.deepEqual(await data.json(), { status: 503, error: 'Service Unavailable' });
    } finally {
      await runtime.close();
    }

    assert.equal(disconnectCalls, 1);
  });

  it('reports both socket-close and Redis-disconnect failures', async () => {
    const disconnectError = new Error('Redis disconnect failed');
    const runtime = await startServer({
      config: config(),
      connectRedis: async () => undefined,
      disconnectRedis: async () => {
        throw disconnectError;
      },
    });

    await new Promise<void>((resolve, reject) => {
      runtime.server.close((error) => (error ? reject(error) : resolve()));
    });

    await assert.rejects(runtime.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, 'query API server and Redis shutdown both failed');
      assert.equal(error.errors.length, 2);
      assert.equal((error.errors[0] as { code?: unknown }).code, 'ERR_SERVER_NOT_RUNNING');
      assert.equal(error.errors[1], disconnectError);
      return true;
    });
  });

  it('reports both listen and Redis-cleanup failures', async () => {
    const blockingServer = createServer();
    await new Promise<void>((resolve) => blockingServer.listen(0, resolve));
    const address = blockingServer.address();
    assert.ok(address && typeof address !== 'string');
    const disconnectError = new Error('Redis cleanup failed');

    try {
      await assert.rejects(
        startServer({
          config: config({ PORT: address.port }),
          connectRedis: async () => undefined,
          disconnectRedis: async () => {
            throw disconnectError;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, 'query API startup and Redis cleanup both failed');
          assert.equal(error.errors.length, 2);
          assert.equal((error.errors[0] as { code?: unknown }).code, 'EADDRINUSE');
          assert.equal(error.errors[1], disconnectError);
          return true;
        }
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        blockingServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
