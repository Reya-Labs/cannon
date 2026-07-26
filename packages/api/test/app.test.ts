/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { createApp } from '../src/app';
import type { ApiConfig } from '../src/config';

const openServers = new Set<Server>();

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    CORS_ORIGINS: new Set(['https://cannon.reya.network']),
    METRICS_PASSWORD: 'a-strong-metrics-password',
    METRICS_USER: 'metrics',
    NODE_ENV: 'test',
    PORT: 8080,
    READINESS_CACHE_MS: 50,
    READINESS_TIMEOUT_MS: 50,
    REDIS_URL: 'redis://localhost:6379/',
    TRUST_PROXY: false,
    ...overrides,
  };
}

async function request(
  path: string,
  options: {
    checkReadiness?: (signal: AbortSignal) => Promise<void>;
    config?: ApiConfig;
    headers?: Record<string, string>;
    method?: string;
    now?: () => number;
  } = {}
) {
  const baseUrl = await serve(options);
  return fetch(`${baseUrl}${path}`, { headers: options.headers, method: options.method });
}

async function serve(
  options: { checkReadiness?: (signal: AbortSignal) => Promise<void>; config?: ApiConfig; now?: () => number } = {}
): Promise<string> {
  const app = createApp({
    checkReadiness: options.checkReadiness ?? (async () => undefined),
    config: options.config ?? config(),
    now: options.now,
  });
  const server = createServer(app);
  openServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  openServers.clear();
});

describe('query API probes and browser boundary', () => {
  it('keeps liveness independent from Redis readiness', async () => {
    let readinessCalls = 0;
    const checkReadiness = async () => {
      readinessCalls += 1;
      throw new Error('Redis unavailable');
    };

    const response = await request('/livez', { checkReadiness });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', version: '1.0.0' });
    assert.equal(readinessCalls, 0);
  });

  it('returns 503 when Redis is unavailable or the probe times out', async () => {
    const unavailable = await request('/readyz', {
      checkReadiness: async () => {
        throw new Error('Redis unavailable');
      },
    });
    assert.equal(unavailable.status, 503);

    const timedOut = await request('/readyz', {
      checkReadiness: () => new Promise<void>(() => undefined),
      config: config({ READINESS_TIMEOUT_MS: 10 }),
    });
    assert.equal(timedOut.status, 503);
  });

  it('aborts and coalesces a hung attempt, then recovers after its failure TTL', async () => {
    let currentTime = 1_000;
    let aborted = 0;
    let readinessCalls = 0;
    const checkReadiness = (signal: AbortSignal) => {
      readinessCalls += 1;
      if (readinessCalls > 1) return Promise.resolve();
      return new Promise<void>(() => {
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
          },
          { once: true }
        );
      });
    };
    const testConfig = config({ READINESS_CACHE_MS: 50, READINESS_TIMEOUT_MS: 10 });
    const baseUrl = await serve({ checkReadiness, config: testConfig, now: () => currentTime });

    const [first, second] = await Promise.all([fetch(`${baseUrl}/readyz`), fetch(`${baseUrl}/readyz`)]);

    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(readinessCalls, 1);
    assert.equal(aborted, 1);
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
    assert.equal(readinessCalls, 1);

    currentTime += 50;
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal(readinessCalls, 2);
  });

  it('caches successful readiness results for a bounded interval', async () => {
    let currentTime = 1_000;
    let readinessCalls = 0;
    const baseUrl = await serve({
      checkReadiness: async () => {
        readinessCalls += 1;
      },
      config: config({ READINESS_CACHE_MS: 50 }),
      now: () => currentTime,
    });

    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal(readinessCalls, 1);

    currentTime += 50;
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal(readinessCalls, 2);
  });

  it('caches failed readiness results, then recovers after the bounded interval', async () => {
    let currentTime = 1_000;
    let readinessCalls = 0;
    const baseUrl = await serve({
      checkReadiness: async () => {
        readinessCalls += 1;
        if (readinessCalls === 1) throw new Error('Redis unavailable');
      },
      config: config({ READINESS_CACHE_MS: 50 }),
      now: () => currentTime,
    });

    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 503);
    assert.equal(readinessCalls, 1);

    currentTime += 50;
    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 200);
    assert.equal(readinessCalls, 2);
  });

  it('returns 200 only after the readiness dependency succeeds', async () => {
    const response = await request('/readyz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', version: '1.0.0' });
  });

  it('reflects only configured origins and rejects all other browser origins', async () => {
    const allowed = await request('/livez', {
      headers: { origin: 'https://cannon.reya.network' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://cannon.reya.network');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const denied = await request('/livez', {
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  it('handles allowed and denied CORS preflight without exposing credentials', async () => {
    const allowed = await request('/search', {
      headers: { origin: 'https://cannon.reya.network' },
      method: 'OPTIONS',
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://cannon.reya.network');
    assert.equal(allowed.headers.get('access-control-allow-methods'), 'GET,OPTIONS');
    assert.equal(allowed.headers.get('access-control-allow-headers'), 'Content-Type');
    assert.equal(allowed.headers.get('access-control-allow-credentials'), null);

    const denied = await request('/search', {
      headers: { origin: 'https://attacker.example' },
      method: 'OPTIONS',
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  it('protects the metrics endpoint and serves metrics with valid credentials', async () => {
    const baseUrl = await serve();

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Basic');

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${baseUrl}/metrics`, { method });
      assert.equal(response.status, 401, `${method} must not bypass metrics authentication`);
    }

    const wrong = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Basic ${Buffer.from('metrics:wrong-password').toString('base64')}` },
    });
    assert.equal(wrong.status, 401);

    const authorized = await fetch(`${baseUrl}/metrics`, {
      headers: {
        authorization: `Basic ${Buffer.from('metrics:a-strong-metrics-password').toString('base64')}`,
      },
    });
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(await authorized.text(), /http_request_duration_seconds/);
  });
});
