import { describe, expect, it } from 'vitest';
import { loadReyaLocalProfileConfig } from './profile-config';

const ENV = {
  REYA_LOCAL_INGRESS_ORIGIN: 'http://127.0.0.1:8787',
  REYA_LOCAL_PROFILE: 'enabled',
  REYA_LOCAL_SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
  REYA_LOCAL_SOURCE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
};

describe('Reya local website profile configuration', () => {
  it('accepts only the fixed chain, loopback ingress and immutable inputs', () => {
    expect(loadReyaLocalProfileConfig(ENV)).toEqual({
      chainId: 1729,
      ingressOrigin: 'http://127.0.0.1:8787',
      safeAddress: ENV.REYA_LOCAL_SAFE_ADDRESS,
      sourceCommit: ENV.REYA_LOCAL_SOURCE_COMMIT,
      stagingEnabled: false,
    });
  });

  it('requires an explicit exact token before enabling local staging', () => {
    expect(
      loadReyaLocalProfileConfig({
        ...ENV,
        REYA_LOCAL_STAGING: 'enabled',
      }).stagingEnabled
    ).toBe(true);
    expect(() =>
      loadReyaLocalProfileConfig({
        ...ENV,
        REYA_LOCAL_STAGING: 'true',
      })
    ).toThrow(/exactly/);
  });

  it.each([
    ['REYA_LOCAL_PROFILE', 'disabled'],
    ['REYA_LOCAL_INGRESS_ORIGIN', 'http://localhost:8787'],
    ['REYA_LOCAL_INGRESS_ORIGIN', 'https://127.0.0.1:8787'],
    ['REYA_LOCAL_INGRESS_ORIGIN', 'http://127.0.0.1:9999'],
    ['REYA_LOCAL_SAFE_ADDRESS', '0x0000000000000000000000000000000000000000'],
    ['REYA_LOCAL_SOURCE_COMMIT', 'dev'],
  ])('rejects unsafe %s=%s', (key, value) => {
    expect(() => loadReyaLocalProfileConfig({ ...ENV, [key]: value })).toThrow();
  });
});
