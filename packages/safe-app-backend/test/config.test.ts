import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const SAFE = '0x1111111111111111111111111111111111111111';

function validEnv(): Record<string, string | undefined> {
  return {
    ADMISSION_MODE: 'safe-owner',
    AUTH_PROXY_SECRET: 'a-secure-ingress-secret-that-is-long-enough',
    CORS_ORIGINS: 'https://cannon.reya.network',
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
    expect(config.admissionMode).toBe('safe-owner');
    expect(config.redisPrefix).toBe('safe-app-backend:v2:admission:safe-owner:v1');
  });

  it('requires an explicit supported admission mode and rejects the legacy pilot switch', () => {
    expect(() => loadConfig({ ...validEnv(), ADMISSION_MODE: undefined })).toThrow('ADMISSION_MODE is required');
    expect(() => loadConfig({ ...validEnv(), ADMISSION_MODE: 'ci-attestation' })).toThrow();
    expect(() => loadConfig({ ...validEnv(), PILOT_MODE: 'true' })).toThrow(
      'PILOT_MODE is unsupported; configure ADMISSION_MODE=safe-owner explicitly'
    );
  });

  it('rejects implicit RPC discovery and anything except the single Reya Network RPC', () => {
    expect(() => loadConfig({ ...validEnv(), RPC_URLS: 'https://rpc.example.com' })).toThrow('RPC_URLS entries must use');
    expect(() =>
      loadConfig({
        ...validEnv(),
        RPC_URLS: '1=https://rpc.example.com',
        SAFE_ALLOWLIST: `1:${SAFE}`,
      })
    ).toThrow('exactly one endpoint for Reya Network chain 1729');
    expect(() =>
      loadConfig({
        ...validEnv(),
        RPC_URLS: '1729=https://rpc.example.com,1=https://eth.example.com',
      })
    ).toThrow('exactly one endpoint for Reya Network chain 1729');
    expect(() =>
      loadConfig({
        ...validEnv(),
        SAFE_ALLOWLIST: `1:${SAFE}`,
      })
    ).toThrow('one Safe on Reya Network chain 1729');
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

  it('isolates durable state by admission contract version', () => {
    expect(loadConfig({ ...validEnv(), REDIS_PREFIX: 'cannon:production' }).redisPrefix).toBe(
      'cannon:production:admission:safe-owner:v1'
    );
  });
});
