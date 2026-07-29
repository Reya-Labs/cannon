import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  AUTH_PROXY_SECRET: 'x'.repeat(32),
  RPC_UI_ORIGIN: 'https://safe.reya.network',
  RPC_UPSTREAM_URLS_JSON: JSON.stringify([
    'https://mainnet.infura.io/v3/redacted',
    'https://eth-mainnet.g.alchemy.com/v2/redacted',
  ]),
  SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
};

describe('loadConfig', () => {
  it('loads exactly two independent server-only providers', () => {
    const config = loadConfig(valid);
    expect(config.upstreams.map((url) => url.hostname)).toEqual(['mainnet.infura.io', 'eth-mainnet.g.alchemy.com']);
    expect(config.safeAddress).toBe(valid.SAFE_ADDRESS);
  });

  it.each([
    [JSON.stringify(['https://mainnet.infura.io/a']), 'exactly two'],
    [JSON.stringify(['https://mainnet.infura.io/a', 'https://mainnet.infura.io/b']), 'distinct provider'],
    [JSON.stringify(['http://provider-a.example/a', 'https://provider-b.example/b']), 'canonical HTTPS'],
    [JSON.stringify(['https://127.0.0.1/a', 'https://provider-b.example/b']), 'canonical HTTPS'],
    [JSON.stringify(['https://user:pass@provider-a.example/a', 'https://provider-b.example/b']), 'canonical HTTPS'],
  ])('rejects unsafe upstream configuration %#', (value, message) => {
    expect(() => loadConfig({ ...valid, RPC_UPSTREAM_URLS_JSON: value })).toThrow(message);
  });

  it('sanitizes malformed URL parse failures', () => {
    const upstreamCanary = 'secret-upstream-canary';
    const originCanary = 'secret-origin-canary';

    const upstreamFailure = captureFailure(() =>
      loadConfig({
        ...valid,
        RPC_UPSTREAM_URLS_JSON: JSON.stringify([`not-a-url-${upstreamCanary}`, 'https://provider-b.example/rpc']),
      })
    );
    expect(upstreamFailure.message).toBe(
      'RPC upstreams must be canonical HTTPS URLs without credentials, query, fragment, port, or IP host'
    );
    expect(upstreamFailure).not.toHaveProperty('input');
    expect(upstreamFailure.stack).not.toContain(upstreamCanary);

    const originFailure = captureFailure(() => loadConfig({ ...valid, RPC_UI_ORIGIN: `not-a-url-${originCanary}` }));
    expect(originFailure.message).toBe('RPC_UI_ORIGIN must be one canonical HTTPS origin');
    expect(originFailure).not.toHaveProperty('input');
    expect(originFailure.stack).not.toContain(originCanary);
  });

  it('rejects blanket trust proxy and equal auth headers', () => {
    expect(() => loadConfig({ ...valid, TRUST_PROXY: 'true' })).toThrow('TRUST_PROXY=true');
    expect(() => loadConfig({ ...valid, AUTH_IDENTITY_HEADER: 'x-user', AUTH_PROXY_SECRET_HEADER: 'x-user' })).toThrow(
      'must be different'
    );
  });
});

function captureFailure(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected operation to fail');
}
