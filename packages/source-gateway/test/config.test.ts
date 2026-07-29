import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const valid = {
  AUTH_PROXY_SECRET: '0123456789abcdef0123456789abcdef',
  SOURCE_UI_ORIGIN: 'https://cannon.example.ts.net',
};

describe('configuration', () => {
  it('loads a minimal fail-closed configuration', () => {
    expect(loadConfig(valid)).toEqual({
      auth: {
        identityHeader: 'x-reya-user',
        proxySecret: valid.AUTH_PROXY_SECRET,
        proxySecretHeader: 'x-reya-proxy-secret',
      },
      port: 8080,
      rateLimit: { limit: 60, windowMs: 60_000 },
      trustProxy: false,
      uiOrigin: valid.SOURCE_UI_ORIGIN,
    });
  });

  it.each([
    [{ ...valid, AUTH_PROXY_SECRET: undefined }, /AUTH_PROXY_SECRET is required/],
    [{ ...valid, AUTH_PROXY_SECRET: 'short' }, /at least 32 bytes/],
    [{ ...valid, SOURCE_UI_ORIGIN: 'http://cannon.example.ts.net' }, /canonical HTTPS origin/],
    [{ ...valid, SOURCE_UI_ORIGIN: 'https://cannon.example.ts.net/path' }, /canonical HTTPS origin/],
    [{ ...valid, SOURCE_UI_ORIGIN: 'https://cannon.example.ts.net:8443' }, /canonical HTTPS origin/],
    [{ ...valid, TRUST_PROXY: 'true' }, /TRUST_PROXY=true is forbidden/],
    [{ ...valid, TRUST_PROXY: '17' }, /outside the supported range/],
    [{ ...valid, TRUST_PROXY: '10.0.0.1/99' }, /invalid address/],
    [{ ...valid, TRUST_PROXY: '2001:db8::1/129' }, /invalid address/],
    [{ ...valid, AUTH_IDENTITY_HEADER: 'bad header' }, /valid HTTP header/],
    [
      {
        ...valid,
        AUTH_IDENTITY_HEADER: 'x-reya-auth',
        AUTH_PROXY_SECRET_HEADER: 'x-reya-auth',
      },
      /must be different/,
    ],
    [{ ...valid, PORT: '0' }, /positive integer/],
  ] as const)('rejects unsafe configuration %#', (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message);
  });

  it('accepts exact proxy addresses, CIDRs, and hop counts', () => {
    expect(loadConfig({ ...valid, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...valid, TRUST_PROXY: '10.0.0.0/8, 2001:db8::/32' }).trustProxy).toBe('10.0.0.0/8, 2001:db8::/32');
  });
});
