/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
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
});
