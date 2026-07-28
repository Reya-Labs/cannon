/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config';

function validEnvironment(): Record<string, string> {
  return {
    CORS_ORIGINS: 'https://cannon.reya.network',
    METRICS_PASSWORD: 'a-strong-metrics-password',
    METRICS_USER: 'metrics',
    NODE_ENV: 'production',
    REDIS_URL: 'redis://redis.internal:6379',
  };
}

describe('query API configuration', () => {
  it('fails closed without production browser and dependency configuration', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /METRICS_USER is required/);
    assert.throws(() => loadConfig({ ...validEnvironment(), CORS_ORIGINS: '' }), /CORS_ORIGINS is required/);
  });

  it('accepts exact HTTPS origins and deterministic proxy trust', () => {
    const config = loadConfig({
      ...validEnvironment(),
      CORS_ORIGINS: 'https://cannon.reya.network,https://staging-cannon.reya.network',
      TRUST_PROXY: '10.0.0.0/8,2001:db8::1/128',
    });

    assert.deepEqual([...config.CORS_ORIGINS], ['https://cannon.reya.network', 'https://staging-cannon.reya.network']);
    assert.equal(config.TRUST_PROXY, '10.0.0.0/8,2001:db8::1/128');
    assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '2' }).TRUST_PROXY, 2);
  });

  for (const origin of [
    '*',
    'https://user:password@cannon.reya.network',
    'https://cannon.reya.network/path',
    'https://cannon.reya.network?query=true',
    'http://cannon.reya.network',
  ]) {
    it(`rejects unsafe CORS origin ${origin}`, () => {
      assert.throws(() => loadConfig({ ...validEnvironment(), CORS_ORIGINS: origin }), /CORS_ORIGINS/);
    });
  }

  for (const trustProxy of ['true', '0', '11', '0.0.0.0/0', '::/0', '10.0.0.0/33', '2001:db8::1/129', 'proxy.internal']) {
    it(`rejects unsafe proxy trust ${trustProxy}`, () => {
      assert.throws(() => loadConfig({ ...validEnvironment(), TRUST_PROXY: trustProxy }), /TRUST_PROXY/);
    });
  }

  it('rejects numeric proxy hops outside development and test', () => {
    assert.throws(
      () => loadConfig({ ...validEnvironment(), TRUST_PROXY: '2' }),
      /numeric TRUST_PROXY is allowed only in development and test/
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment(), NODE_ENV: 'staging', TRUST_PROXY: '1' }),
      /numeric TRUST_PROXY is allowed only in development and test/
    );
  });

  it('allows only loopback HTTP origins for local development', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).CORS_ORIGINS.has('http://localhost:3000'), true);
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://192.0.2.1:3000' }),
      /requires HTTPS outside loopback/
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://127.attacker.example:3000' }),
      /requires HTTPS outside loopback/
    );
  });

  it('bounds readiness timeouts and result caching', () => {
    assert.equal(loadConfig(validEnvironment()).READINESS_CACHE_MS, 5_000);
    assert.throws(
      () => loadConfig({ ...validEnvironment(), READINESS_CACHE_MS: '9' }),
      /READINESS_CACHE_MS must be between 10 and 60000/
    );
    assert.throws(
      () => loadConfig({ ...validEnvironment(), READINESS_CACHE_MS: '60001' }),
      /READINESS_CACHE_MS must be between 10 and 60000/
    );
  });
});
