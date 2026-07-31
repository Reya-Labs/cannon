const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
export const REYA_PRODUCTION_INGRESS_ORIGIN = 'https://cannon-safe-staging.tailf2022c.ts.net';
export const REYA_PRODUCTION_SITE_ORIGIN = 'https://cannon.reya.xyz';

/**
 * Immutable configuration embedded in the local-only Reya website export.
 *
 * Chain ID 1729 and the `127.0.0.1:8787` ingress are fixed. The Safe address
 * and full source commit come from required build-time environment variables.
 */
export type ReyaLocalProfileConfig = Readonly<{
  chainId: 1729;
  ingressOrigin: string;
  safeAddress: `0x${string}`;
  sourceCommit: string;
  stagingEnabled: boolean;
}>;

export type ReyaProductionProfileConfig = ReyaLocalProfileConfig &
  Readonly<{
    profile: 'production';
    siteOrigin: string;
  }>;

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('REYA_LOCAL_INGRESS_ORIGIN is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin
  ) {
    throw new Error('REYA_LOCAL_INGRESS_ORIGIN must be one canonical 127.0.0.1 HTTP origin');
  }
  if (url.origin !== 'http://127.0.0.1:8787') {
    throw new Error('REYA_LOCAL_INGRESS_ORIGIN must be http://127.0.0.1:8787');
  }
  return url.origin;
}

function exactProductionOrigin(value: string, expected: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin ||
    url.origin !== expected
  ) {
    throw new Error(`${key} must be exactly ${expected}`);
  }
  return url.origin;
}

function stagingEnabled(value: string | undefined): boolean {
  const normalized = value?.trim() || 'disabled';
  if (normalized !== 'disabled' && normalized !== 'enabled') {
    throw new Error('REYA_LOCAL_STAGING must be exactly "disabled" or "enabled"');
  }
  return normalized === 'enabled';
}

/**
 * Loads immutable build-time configuration for the constrained local profile.
 *
 * Requires `REYA_LOCAL_PROFILE`, `REYA_LOCAL_INGRESS_ORIGIN`,
 * `REYA_LOCAL_SAFE_ADDRESS`, and `REYA_LOCAL_SOURCE_COMMIT`. It throws and
 * prevents the export unless explicitly enabled and pinned to the fixed chain,
 * loopback ingress, one non-zero Safe, and one lowercase full source commit.
 */
export function loadReyaLocalProfileConfig(env: Record<string, string | undefined> = process.env): ReyaLocalProfileConfig {
  if (required(env, 'REYA_LOCAL_PROFILE') !== 'enabled') {
    throw new Error('REYA_LOCAL_PROFILE must be enabled');
  }
  const safeAddress = required(env, 'REYA_LOCAL_SAFE_ADDRESS');
  if (!ADDRESS_PATTERN.test(safeAddress) || safeAddress === ZERO_ADDRESS) {
    throw new Error('REYA_LOCAL_SAFE_ADDRESS must be one non-zero lowercase EVM address');
  }
  const sourceCommit = required(env, 'REYA_LOCAL_SOURCE_COMMIT');
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('REYA_LOCAL_SOURCE_COMMIT must be one lowercase full Git commit');
  }

  return Object.freeze({
    chainId: 1729,
    ingressOrigin: loopbackOrigin(required(env, 'REYA_LOCAL_INGRESS_ORIGIN')),
    safeAddress: safeAddress as `0x${string}`,
    sourceCommit,
    stagingEnabled: stagingEnabled(env.REYA_LOCAL_STAGING),
  });
}

/** Loads the immutable Cloudflare + Tailscale production signer profile. */
export function loadReyaProductionProfileConfig(
  env: Record<string, string | undefined> = process.env
): ReyaProductionProfileConfig {
  if (required(env, 'REYA_PRODUCTION_PROFILE') !== 'enabled') {
    throw new Error('REYA_PRODUCTION_PROFILE must be enabled');
  }
  if (required(env, 'REYA_PRODUCTION_STAGING') !== 'enabled') {
    throw new Error('REYA_PRODUCTION_STAGING must be enabled');
  }
  const safeAddress = required(env, 'REYA_PRODUCTION_SAFE_ADDRESS');
  if (!ADDRESS_PATTERN.test(safeAddress) || safeAddress === ZERO_ADDRESS) {
    throw new Error('REYA_PRODUCTION_SAFE_ADDRESS must be one non-zero lowercase EVM address');
  }
  const sourceCommit = required(env, 'REYA_PRODUCTION_SOURCE_COMMIT');
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('REYA_PRODUCTION_SOURCE_COMMIT must be one lowercase full Git commit');
  }

  return Object.freeze({
    chainId: 1729,
    ingressOrigin: exactProductionOrigin(
      required(env, 'REYA_PRODUCTION_INGRESS_ORIGIN'),
      REYA_PRODUCTION_INGRESS_ORIGIN,
      'REYA_PRODUCTION_INGRESS_ORIGIN'
    ),
    profile: 'production',
    safeAddress: safeAddress as `0x${string}`,
    siteOrigin: exactProductionOrigin(
      required(env, 'REYA_PRODUCTION_SITE_ORIGIN'),
      REYA_PRODUCTION_SITE_ORIGIN,
      'REYA_PRODUCTION_SITE_ORIGIN'
    ),
    sourceCommit,
    stagingEnabled: true,
  });
}
