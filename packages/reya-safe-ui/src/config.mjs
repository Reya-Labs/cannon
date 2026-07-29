import { createHash } from 'node:crypto';

const ENV_PREFIX = 'REYA_SAFE_UI_';

const EXPECTED_ENV = Object.freeze({
  REYA_SAFE_UI_ACTIVATION: 'disabled',
  REYA_SAFE_UI_CHAIN_ID: '1729',
  REYA_SAFE_UI_PROFILE: 'reya-mainnet',
});

const ALLOWED_ENV = new Set([
  ...Object.keys(EXPECTED_ENV),
  'REYA_SAFE_UI_BUILD_SHA',
  'REYA_SAFE_UI_SAFE_ADDRESS',
  'REYA_SAFE_UI_SERVICE_ORIGIN',
]);
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const TAILSCALE_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/;
const PROFILE_KEYS = Object.freeze([
  'activation',
  'cannon',
  'chainId',
  'name',
  'safeAddress',
  'schemaVersion',
  'serviceOrigin',
  'source',
]);
const CANNON_KEYS = Object.freeze(['stateFormatVersion', 'version']);
const SOURCE_KEYS = Object.freeze([
  'repository',
  'revisionInput',
  'root',
  'workflow',
]);
const CANNON_PROFILE = Object.freeze({
  stateFormatVersion: 7,
  version: '2.26.1',
});
const SOURCE_PROFILE = Object.freeze({
  repository: 'Reya-Labs/reya-deployments',
  revisionInput: 'lowercase-full-commit-sha',
  root: 'packages/tomls/src/omnibus/reya_network.toml',
  workflow: 'reya-network',
});

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === 'string' && expected.includes(key)
    )
  );
}

function safeAddress(value) {
  if (
    typeof value !== 'string' ||
    !SAFE_ADDRESS_PATTERN.test(value) ||
    value === `0x${'0'.repeat(40)}`
  ) {
    throw new Error(
      'REYA_SAFE_UI_SAFE_ADDRESS must be one non-zero lowercase EVM address'
    );
  }
  return value;
}

function serviceOrigin(value) {
  if (typeof value !== 'string' || value.length > 253) {
    throw new Error(
      'REYA_SAFE_UI_SERVICE_ORIGIN must be one canonical HTTPS Tailscale origin'
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'REYA_SAFE_UI_SERVICE_ORIGIN must be one canonical HTTPS Tailscale origin'
    );
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !TAILSCALE_HOST_PATTERN.test(parsed.hostname) ||
    value !== parsed.origin
  ) {
    throw new Error(
      'REYA_SAFE_UI_SERVICE_ORIGIN must be one canonical HTTPS Tailscale origin'
    );
  }
  return value;
}

/**
 * Validates and canonicalizes the immutable Reya preview release profile.
 *
 * @param {unknown} value
 * @returns {Readonly<object>}
 */
export function validatePreviewProfile(value) {
  if (
    !exactKeys(value, PROFILE_KEYS) ||
    !exactKeys(value.cannon, CANNON_KEYS) ||
    !exactKeys(value.source, SOURCE_KEYS)
  ) {
    throw new Error('Reya Safe UI preview profile has unexpected fields');
  }
  if (
    value.schemaVersion !== 2 ||
    value.name !== EXPECTED_ENV.REYA_SAFE_UI_PROFILE ||
    value.chainId !== Number(EXPECTED_ENV.REYA_SAFE_UI_CHAIN_ID) ||
    value.activation !== EXPECTED_ENV.REYA_SAFE_UI_ACTIVATION ||
    JSON.stringify(value.cannon) !== JSON.stringify(CANNON_PROFILE) ||
    JSON.stringify(value.source) !== JSON.stringify(SOURCE_PROFILE)
  ) {
    throw new Error('Reya Safe UI preview profile is not canonical');
  }

  return Object.freeze({
    activation: EXPECTED_ENV.REYA_SAFE_UI_ACTIVATION,
    cannon: CANNON_PROFILE,
    chainId: Number(EXPECTED_ENV.REYA_SAFE_UI_CHAIN_ID),
    name: EXPECTED_ENV.REYA_SAFE_UI_PROFILE,
    safeAddress: safeAddress(value.safeAddress),
    schemaVersion: 2,
    serviceOrigin: serviceOrigin(value.serviceOrigin),
    source: SOURCE_PROFILE,
  });
}

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function compareCanonicalText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function digestFiles(files) {
  const hash = createHash('sha256');

  for (const file of [...files].sort((left, right) =>
    compareCanonicalText(left.path, right.path)
  )) {
    const bytes = Buffer.isBuffer(file.bytes)
      ? file.bytes
      : Buffer.from(file.bytes);
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }

  return `sha256:${hash.digest('hex')}`;
}

export function validateBuildEnvironment(env) {
  const unknown = Object.keys(env)
    .filter((key) => key.startsWith(ENV_PREFIX) && !ALLOWED_ENV.has(key))
    .sort();

  if (unknown.length > 0) {
    throw new Error(
      `unknown Reya Safe UI configuration: ${unknown.join(', ')}`
    );
  }

  for (const [key, expected] of Object.entries(EXPECTED_ENV)) {
    const actual = required(env, key);
    if (actual !== expected) {
      throw new Error(`${key} must be exactly "${expected}"`);
    }
  }

  const buildSha = required(env, 'REYA_SAFE_UI_BUILD_SHA');
  if (!BUILD_SHA_PATTERN.test(buildSha)) {
    throw new Error(
      'REYA_SAFE_UI_BUILD_SHA must be a lowercase 40-character Git commit SHA'
    );
  }

  const profile = validatePreviewProfile({
    activation: EXPECTED_ENV.REYA_SAFE_UI_ACTIVATION,
    cannon: CANNON_PROFILE,
    chainId: Number(EXPECTED_ENV.REYA_SAFE_UI_CHAIN_ID),
    name: EXPECTED_ENV.REYA_SAFE_UI_PROFILE,
    safeAddress: required(env, 'REYA_SAFE_UI_SAFE_ADDRESS'),
    schemaVersion: 2,
    serviceOrigin: required(env, 'REYA_SAFE_UI_SERVICE_ORIGIN'),
    source: SOURCE_PROFILE,
  });

  return Object.freeze({
    buildSha,
    configDigest: sha256(JSON.stringify(profile)),
    profile,
  });
}
