import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateBuildEnvironment,
  validatePreviewProfile,
} from '../src/config.mjs';
import { REYA_CHAIN_ID } from '../src/clients/config.mjs';
import {
  SOURCE_REPOSITORY,
  SOURCE_ROOT,
  SOURCE_ROUTE_PREFIX,
} from '../src/clients/source.mjs';
import {
  SAFE_ADDRESS,
  SERVICE_ORIGIN,
} from '../test-support/client-fixtures.mjs';

const BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';

function validEnvironment() {
  return {
    REYA_SAFE_UI_ACTIVATION: 'disabled',
    REYA_SAFE_UI_BUILD_SHA: BUILD_SHA,
    REYA_SAFE_UI_CHAIN_ID: '1729',
    REYA_SAFE_UI_PROFILE: 'reya-mainnet',
    REYA_SAFE_UI_SAFE_ADDRESS: SAFE_ADDRESS,
    REYA_SAFE_UI_SERVICE_ORIGIN: SERVICE_ORIGIN,
  };
}

test('accepts only the canonical disabled Reya mainnet profile', () => {
  const result = validateBuildEnvironment(validEnvironment());

  assert.equal(result.buildSha, BUILD_SHA);
  assert.deepEqual(result.profile, {
    activation: 'disabled',
    cannon: {
      stateFormatVersion: 7,
      version: '2.26.1',
    },
    chainId: 1729,
    name: 'reya-mainnet',
    safeAddress: SAFE_ADDRESS,
    schemaVersion: 2,
    serviceOrigin: SERVICE_ORIGIN,
    source: {
      repository: 'Reya-Labs/reya-deployments',
      revisionInput: 'lowercase-full-commit-sha',
      root: 'packages/tomls/src/omnibus/reya_network.toml',
      workflow: 'reya-network',
    },
  });
  assert.match(result.configDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.profile));
  assert.ok(Object.isFrozen(result.profile.cannon));
  assert.ok(Object.isFrozen(result.profile.source));
});

for (const key of [
  'REYA_SAFE_UI_ACTIVATION',
  'REYA_SAFE_UI_BUILD_SHA',
  'REYA_SAFE_UI_CHAIN_ID',
  'REYA_SAFE_UI_PROFILE',
  'REYA_SAFE_UI_SAFE_ADDRESS',
  'REYA_SAFE_UI_SERVICE_ORIGIN',
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

for (const safeAddress of [
  `0x${'0'.repeat(40)}`,
  '0x111111111111111111111111111111111111111',
  '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ' 0x1111111111111111111111111111111111111111',
]) {
  test(`rejects non-canonical Safe address ${safeAddress}`, () => {
    assert.throws(
      () =>
        validateBuildEnvironment({
          ...validEnvironment(),
          REYA_SAFE_UI_SAFE_ADDRESS: safeAddress,
        }),
      /one non-zero lowercase EVM address/
    );
  });
}

for (const serviceOrigin of [
  'http://cannon-api.reya-tailnet.ts.net',
  'https://repo.usecannon.com',
  'https://cannon-api.reya-tailnet.ts.net/',
  'https://cannon-api.reya-tailnet.ts.net/path',
  'https://cannon-api.reya-tailnet.ts.net:443',
  'https://user@cannon-api.reya-tailnet.ts.net',
  'https://CANNON-api.reya-tailnet.ts.net',
  'not a URL',
]) {
  test(`rejects non-canonical service origin ${serviceOrigin}`, () => {
    assert.throws(
      () =>
        validateBuildEnvironment({
          ...validEnvironment(),
          REYA_SAFE_UI_SERVICE_ORIGIN: serviceOrigin,
        }),
      /one canonical HTTPS Tailscale origin/
    );
  });
}

test('binds the approved Safe and service origin into the configuration digest', () => {
  const baseline = validateBuildEnvironment(validEnvironment());
  const differentSafe = validateBuildEnvironment({
    ...validEnvironment(),
    REYA_SAFE_UI_SAFE_ADDRESS:
      '0x2222222222222222222222222222222222222222',
  });
  const differentOrigin = validateBuildEnvironment({
    ...validEnvironment(),
    REYA_SAFE_UI_SERVICE_ORIGIN:
      'https://cannon-api.other-tailnet.ts.net',
  });

  assert.notEqual(baseline.configDigest, differentSafe.configDigest);
  assert.notEqual(baseline.configDigest, differentOrigin.configDigest);
});

test('keeps the release profile aligned with the dormant read contract', () => {
  const { profile } = validateBuildEnvironment(validEnvironment());

  assert.equal(profile.chainId, REYA_CHAIN_ID);
  assert.equal(profile.source.repository, SOURCE_REPOSITORY);
  assert.equal(profile.source.root, SOURCE_ROOT);
  assert.equal(
    SOURCE_ROUTE_PREFIX,
    `/source/${profile.source.repository.split('/').at(-1).toLowerCase()}/`
  );
  assert.equal(profile.source.workflow, 'reya-network');
});

test('rejects additions and changes to the immutable preview profile', () => {
  const baseline = validateBuildEnvironment(validEnvironment()).profile;

  assert.throws(
    () => validatePreviewProfile({ ...baseline, fallbackOrigin: SERVICE_ORIGIN }),
    /unexpected fields/
  );
  assert.throws(
    () =>
      validatePreviewProfile({
        ...baseline,
        cannon: { ...baseline.cannon, version: 'latest' },
      }),
    /not canonical/
  );
  assert.throws(
    () =>
      validatePreviewProfile({
        ...baseline,
        source: {
          ...baseline.source,
          repository: 'usecannon/cannon',
        },
      }),
    /not canonical/
  );

  const symbolKeyed = { ...baseline };
  symbolKeyed[Symbol('credential')] = 'hidden';
  assert.throws(() => validatePreviewProfile(symbolKeyed), /unexpected fields/);
});

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
