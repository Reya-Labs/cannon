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
]);
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
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

  const profile = Object.freeze({
    schemaVersion: 1,
    name: EXPECTED_ENV.REYA_SAFE_UI_PROFILE,
    chainId: Number(EXPECTED_ENV.REYA_SAFE_UI_CHAIN_ID),
    activation: EXPECTED_ENV.REYA_SAFE_UI_ACTIVATION,
  });

  return Object.freeze({
    buildSha,
    configDigest: sha256(JSON.stringify(profile)),
    profile,
  });
}
