import { describe, expect, it } from 'vitest';
import {
  loadReyaLocalProfileConfig,
  loadReyaProductionProfileConfig,
  REYA_PRODUCTION_INGRESS_ORIGIN,
  REYA_PRODUCTION_SITE_ORIGIN,
} from './profile-config';

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

const PRODUCTION_ENV = {
  REYA_PRODUCTION_INGRESS_ORIGIN,
  REYA_PRODUCTION_PROFILE: 'enabled',
  REYA_PRODUCTION_SAFE_ADDRESS: '0x1fe50318e5e3165742edc9c4a15d997bdb935eb9',
  REYA_PRODUCTION_SITE_ORIGIN,
  REYA_PRODUCTION_SOURCE_COMMIT: '2b10669075b91eb8db781d199292f30c52f8e994',
  REYA_PRODUCTION_STAGING: 'enabled',
};

describe('Reya production website profile configuration', () => {
  it('pins the exact Cloudflare site and Tailscale HTTPS ingress', () => {
    expect(loadReyaProductionProfileConfig(PRODUCTION_ENV)).toEqual({
      chainId: 1729,
      ingressOrigin: REYA_PRODUCTION_INGRESS_ORIGIN,
      profile: 'production',
      safeAddress: PRODUCTION_ENV.REYA_PRODUCTION_SAFE_ADDRESS,
      siteOrigin: REYA_PRODUCTION_SITE_ORIGIN,
      sourceCommit: PRODUCTION_ENV.REYA_PRODUCTION_SOURCE_COMMIT,
      stagingEnabled: true,
    });
  });

  it.each([
    ['REYA_PRODUCTION_PROFILE', 'disabled'],
    ['REYA_PRODUCTION_STAGING', 'disabled'],
    ['REYA_PRODUCTION_INGRESS_ORIGIN', 'https://repo.usecannon.com'],
    ['REYA_PRODUCTION_INGRESS_ORIGIN', `${REYA_PRODUCTION_INGRESS_ORIGIN}/api`],
    ['REYA_PRODUCTION_SITE_ORIGIN', 'https://preview.cannon.reya.xyz'],
    ['REYA_PRODUCTION_SAFE_ADDRESS', '0x0000000000000000000000000000000000000000'],
    ['REYA_PRODUCTION_SOURCE_COMMIT', 'dev'],
  ])('rejects unsafe %s=%s', (key, value) => {
    expect(() =>
      loadReyaProductionProfileConfig({
        ...PRODUCTION_ENV,
        [key]: value,
      })
    ).toThrow();
  });
});
