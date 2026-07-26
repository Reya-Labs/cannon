import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBuildEnvironment } from '../src/config.mjs';

const BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';

function validEnvironment() {
  return {
    REYA_SAFE_UI_ACTIVATION: 'disabled',
    REYA_SAFE_UI_BUILD_SHA: BUILD_SHA,
    REYA_SAFE_UI_CHAIN_ID: '1729',
    REYA_SAFE_UI_PROFILE: 'reya-mainnet',
  };
}

test('accepts only the canonical disabled Reya mainnet profile', () => {
  const result = validateBuildEnvironment(validEnvironment());

  assert.equal(result.buildSha, BUILD_SHA);
  assert.deepEqual(result.profile, {
    schemaVersion: 1,
    name: 'reya-mainnet',
    chainId: 1729,
    activation: 'disabled',
  });
  assert.match(result.configDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.profile));
});

for (const key of [
  'REYA_SAFE_UI_ACTIVATION',
  'REYA_SAFE_UI_BUILD_SHA',
  'REYA_SAFE_UI_CHAIN_ID',
  'REYA_SAFE_UI_PROFILE',
]) {
  test(`fails closed when ${key} is missing`, () => {
    const env = validEnvironment();
    delete env[key];
    assert.throws(
      () => validateBuildEnvironment(env),
      new RegExp(`${key} is required`)
    );
  });
}

for (const [key, value] of [
  ['REYA_SAFE_UI_ACTIVATION', 'enabled'],
  ['REYA_SAFE_UI_CHAIN_ID', '1'],
  ['REYA_SAFE_UI_CHAIN_ID', '01729'],
  ['REYA_SAFE_UI_PROFILE', 'preview'],
]) {
  test(`rejects non-canonical ${key}=${value}`, () => {
    assert.throws(
      () => validateBuildEnvironment({ ...validEnvironment(), [key]: value }),
      new RegExp(`${key} must be exactly`)
    );
  });
}

for (const buildSha of [
  '0123456789abcdef0123456789abcdef0123456',
  '0123456789abcdef0123456789abcdef012345678',
  '0123456789ABCDEF0123456789ABCDEF01234567',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
]) {
  test(`rejects invalid build revision ${buildSha}`, () => {
    assert.throws(
      () =>
        validateBuildEnvironment({
          ...validEnvironment(),
          REYA_SAFE_UI_BUILD_SHA: buildSha,
        }),
      /lowercase 40-character Git commit SHA/
    );
  });
}

test('rejects every unreviewed Reya Safe UI setting', () => {
  assert.throws(
    () =>
      validateBuildEnvironment({
        ...validEnvironment(),
        REYA_SAFE_UI_RPC_URL: 'internal endpoint',
      }),
    /unknown Reya Safe UI configuration: REYA_SAFE_UI_RPC_URL/
  );
});

test('ignores unrelated process settings', () => {
  assert.doesNotThrow(() =>
    validateBuildEnvironment({
      ...validEnvironment(),
      CI: 'true',
      PATH: '/bin',
    })
  );
});
