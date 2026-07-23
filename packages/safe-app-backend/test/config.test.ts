import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const SAFE = '0x1111111111111111111111111111111111111111';

function validEnv(): Record<string, string | undefined> {
  return {
    AUTH_PROXY_SECRET: 'a-secure-ingress-secret-that-is-long-enough',
    CORS_ORIGINS: 'https://cannon.reya.network',
    PILOT_MODE: 'true',
    REDIS_URL: 'redis://127.0.0.1:6379',
    RPC_URLS: '1729=https://rpc.example.com',
    SAFE_ALLOWLIST: `1729:${SAFE}`,
  };
}

describe('loadConfig', () => {
  it('requires explicit chain-bound RPCs and Safe allowlists', () => {
    const config = loadConfig(validEnv());

    expect(config.rpcUrls.get(1729)).toBe('https://rpc.example.com/');
    expect(config.safeAllowlist.get(1729)?.has(SAFE)).toBe(true);
    expect(config.pilotMode).toBe(true);
  });

  it('rejects implicit RPC discovery and allowlisted chains without RPCs', () => {
    expect(() => loadConfig({ ...validEnv(), RPC_URLS: 'https://rpc.example.com' })).toThrow('RPC_URLS entries must use');
    expect(() =>
      loadConfig({
        ...validEnv(),
        SAFE_ALLOWLIST: `1:${SAFE}`,
      })
    ).toThrow('has no explicit RPC_URLS entry');
  });

  it('rejects wildcard or path-bearing CORS configuration', () => {
    expect(() => loadConfig({ ...validEnv(), CORS_ORIGINS: '*' })).toThrow();
    expect(() => loadConfig({ ...validEnv(), CORS_ORIGINS: 'https://cannon.reya.network/path' })).toThrow('without paths');
  });

  it('rejects a weak trusted-proxy secret', () => {
    expect(() => loadConfig({ ...validEnv(), AUTH_PROXY_SECRET: 'short' })).toThrow('at least 32 bytes');
  });

  it('rejects blanket proxy trust', () => {
    expect(() => loadConfig({ ...validEnv(), TRUST_PROXY: 'true' })).toThrow('exact hop count or proxy IP/CIDR');
    expect(loadConfig({ ...validEnv(), TRUST_PROXY: '1' }).trustProxy).toBe(1);
  });

  it('requires exactly one Safe per deployment until authorization is Safe-scoped', () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        SAFE_ALLOWLIST: `${validEnv().SAFE_ALLOWLIST},1729:0x2222222222222222222222222222222222222222`,
      })
    ).toThrow('exactly one Safe per deployment');

    expect(
      loadConfig({ ...validEnv(), SAFE_ALLOWLIST: `${validEnv().SAFE_ALLOWLIST},${validEnv().SAFE_ALLOWLIST}` })
    ).toMatchObject({
      safeTargets: [{ chainId: 1729 }],
    });
  });

  it('retains proposal quota state for at least the proposal lifetime', () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        HISTORY_RETENTION_SECONDS: '3600',
        PROPOSAL_TTL_SECONDS: '7200',
      })
    ).toThrow('greater than PROPOSAL_TTL_SECONDS');

    expect(() =>
      loadConfig({
        ...validEnv(),
        HISTORY_RETENTION_SECONDS: '7200',
        PROPOSAL_TTL_SECONDS: '7200',
      })
    ).toThrow('greater than PROPOSAL_TTL_SECONDS');
  });
});
