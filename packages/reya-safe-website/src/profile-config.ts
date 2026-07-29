const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export type ReyaLocalProfileConfig = Readonly<{
  chainId: 1729;
  ingressOrigin: string;
  safeAddress: `0x${string}`;
  sourceCommit: string;
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
  });
}
