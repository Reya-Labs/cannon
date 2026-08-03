import assert from 'node:assert/strict';
import test from 'node:test';
import { describeConfig, loadConfig } from '../src/config.mjs';
import { createRegistryResolver } from '../src/registry.mjs';
import { ENV, UI_ORIGIN } from './support.mjs';

function rejects(overrides, message) {
  assert.throws(() => loadConfig({ ...ENV, ...overrides }), Error, message);
}

test('loads the canonical production configuration', () => {
  const config = loadConfig({ ...ENV });
  assert.equal(config.uiOrigin, UI_ORIGIN);
  assert.equal(config.chainId, 1729);
  assert.equal(config.port, 8080);
  assert.equal(config.auth.identityHeader, 'x-reya-user');
  assert.equal(config.auth.rolesHeader, 'x-reya-roles');
});

test('requires exactly one canonical HTTPS UI origin', () => {
  for (const value of [
    '*',
    'http://cannon.reya.xyz',
    'https://cannon.reya.xyz:443',
    'https://cannon.reya.xyz/',
    'https://cannon.reya.xyz/app',
    'https://user:pass@cannon.reya.xyz',
    'https://cannon.reya.xyz https://evil.example',
    'null',
  ]) {
    rejects({ PREVIEW_UI_ORIGIN: value }, value);
  }
});

test('rejects a short proxy secret', () => {
  rejects({ AUTH_PROXY_SECRET: 'short' });
  rejects({ AUTH_PROXY_SECRET: 'a'.repeat(31) });
  assert.ok(loadConfig({ ...ENV, AUTH_PROXY_SECRET: 'a'.repeat(32) }));
});

test('treats a blank optional variable as absent, like the required ones', () => {
  // A secret file read with its trailing newline, or an explicitly empty
  // variable, must fall back rather than fail with a misleading message.
  for (const overrides of [
    { AUTH_IDENTITY_HEADER: '' },
    { AUTH_IDENTITY_HEADER: '   ' },
    { AUTH_IDENTITY_HEADER: 'x-reya-user\n' },
  ]) {
    assert.equal(
      loadConfig({ ...ENV, ...overrides }).auth.identityHeader,
      'x-reya-user',
      JSON.stringify(overrides),
    );
  }
  for (const value of ['', '  ', '8080\n']) {
    assert.equal(
      loadConfig({ ...ENV, PORT: value }).port,
      8080,
      `PORT=${value}`,
    );
  }
  // A non-empty invalid value must still fail.
  rejects({ AUTH_IDENTITY_HEADER: 'not a header' });
  rejects({ PORT: '0' });
});

test('requires the three authentication headers to be distinct', () => {
  rejects({ AUTH_IDENTITY_HEADER: 'x-reya-roles' });
  rejects({ AUTH_PROXY_SECRET_HEADER: 'x-reya-user' });
  rejects({ AUTH_IDENTITY_HEADER: 'not a header' });
});

test('requires canonical, credential-free upstream URLs', () => {
  for (const key of ['PREVIEW_RPC_URL', 'PREVIEW_OP_RPC_URL']) {
    rejects({ [key]: 'http://rpc.example.invalid' }, key);
    rejects({ [key]: 'https://user:pass@rpc.example.invalid/v1' }, key);
    rejects({ [key]: 'https://rpc.example.invalid/v1?key=secret' }, key);
    rejects({ [key]: 'https://rpc.example.invalid/v1#frag' }, key);
  }
});

test('requires internal upstream origins with no path', () => {
  rejects({ PREVIEW_SOURCE_ORIGIN: 'http://source.svc/api' });
  rejects({ PREVIEW_ARTIFACT_ORIGIN: 'artifacts.svc:8080' });
});

test('rejects a zero or malformed Safe address', () => {
  rejects({ PREVIEW_SAFE_ADDRESS: `0x${'0'.repeat(40)}` });
  rejects({ PREVIEW_SAFE_ADDRESS: ENV.PREVIEW_SAFE_ADDRESS.toUpperCase() });
});

test('rejects a malformed pinned commit or CID', () => {
  rejects({ PREVIEW_SOURCE_COMMIT: 'main' });
  rejects({ PREVIEW_PREVIOUS_PACKAGE_CID: 'bafybeiexample' });
});

test('the start-up description never contains an upstream URL or secret', () => {
  const config = loadConfig({ ...ENV });
  const described = JSON.stringify(describeConfig(config));
  assert.ok(!described.includes('token'));
  assert.ok(!described.includes('rpc.example.invalid'));
  assert.ok(!described.includes('op.example.invalid'));
  assert.ok(!described.includes(ENV.AUTH_PROXY_SECRET));
  assert.equal(describeConfig(config).rpcConfigured, true);
  assert.equal(describeConfig(config).opRpcConfigured, true);
});

test('the registry resolver rejects a reference outside the alias family', async () => {
  const resolver = createRegistryResolver({
    fetchImpl: async () => {
      throw new Error('the OP RPC must not be contacted for a bad reference');
    },
    opRpcUrl: ENV.PREVIEW_OP_RPC_URL,
  });
  await assert.rejects(
    () => resolver.resolve({ packageRef: 'other:latest@main' }),
    { code: 'INVALID_REQUEST' },
  );
});

test('the registry resolver collapses an OP outage into REGISTRY_UNAVAILABLE', async () => {
  const resolver = createRegistryResolver({
    fetchImpl: async () => {
      throw new Error(
        'connect ECONNREFUSED https://op.example.invalid/v1/token',
      );
    },
    opRpcUrl: ENV.PREVIEW_OP_RPC_URL,
  });
  await assert.rejects(
    () => resolver.resolve({ packageRef: 'reya-omnibus:latest@main' }),
    (error) => {
      assert.equal(error.code, 'REGISTRY_UNAVAILABLE');
      assert.ok(!error.message.includes('op.example.invalid'));
      return true;
    },
  );
});

test('defaults to the dormant simulator and needs no extra endpoint for it', () => {
  const config = loadConfig({ ...ENV });
  assert.equal(config.simulatorMode, 'disabled');
  assert.equal(config.mainnetRpcUrl, null);
  assert.equal(describeConfig(config).mainnetRpcConfigured, false);
});

test('a fork worker cannot start without the Ethereum Mainnet registry endpoint', () => {
  rejects({ PREVIEW_SIMULATOR_MODE: 'fork' }, 'PREVIEW_MAINNET_RPC_URL');
  const config = loadConfig({
    ...ENV,
    PREVIEW_MAINNET_RPC_URL: 'https://eth.example.invalid/v1/token',
    PREVIEW_SIMULATOR_MODE: 'fork',
  });
  assert.equal(config.simulatorMode, 'fork');
  assert.equal(config.mainnetRpcUrl, 'https://eth.example.invalid/v1/token');
});

test('rejects an unknown simulator mode at start-up', () => {
  rejects({ PREVIEW_SIMULATOR_MODE: 'live' });
  rejects({ PREVIEW_SIMULATOR_MODE: 'FORK' });
});

test('start-up logging reports endpoint presence, never an endpoint', () => {
  const described = describeConfig(
    loadConfig({
      ...ENV,
      PREVIEW_MAINNET_RPC_URL: 'https://eth.example.invalid/v1/token',
      PREVIEW_SIMULATOR_MODE: 'fork',
    }),
  );
  const serialized = JSON.stringify(described);

  assert.equal(described.mainnetRpcConfigured, true);
  assert.equal(described.simulatorMode, 'fork');
  assert.equal(serialized.includes('eth.example.invalid'), false);
  assert.equal(serialized.includes('token'), false);
});
