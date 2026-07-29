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

  it('rejects blanket trust proxy and equal auth headers', () => {
    expect(() => loadConfig({ ...valid, TRUST_PROXY: 'true' })).toThrow('TRUST_PROXY=true');
    expect(() => loadConfig({ ...valid, AUTH_IDENTITY_HEADER: 'x-user', AUTH_PROXY_SECRET_HEADER: 'x-user' })).toThrow(
      'must be different'
    );
  });
});
