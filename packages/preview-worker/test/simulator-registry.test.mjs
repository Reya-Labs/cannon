import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, stringToHex } from 'viem';
import {
  CANNON_REGISTRY_ADDRESS,
  createPreviewRegistry,
  MAX_REGISTRY_LOOKUPS,
  parsePackageReference,
} from '../src/simulator/registry.mjs';
import {
  MAINNET_RPC_URL,
  OP_RPC_URL,
  OTHER_CID,
  PARTIAL_CID,
  PREVIOUS_CID,
  recordingFetch,
  jsonResponse,
} from './simulator-support.mjs';

const PACKAGE_INFO_COMPONENTS = [
  {
    components: [
      { name: 'owner', type: 'address' },
      { name: 'deployUrl', type: 'string' },
      { name: 'metaUrl', type: 'string' },
      { name: 'mutability', type: 'bytes16' },
      { name: '__reserved', type: 'bytes16' },
    ],
    name: '',
    type: 'tuple',
  },
];

function packageInfo({ deployUrl, mutability = 'version' }) {
  return encodeAbiParameters(PACKAGE_INFO_COMPONENTS, [
    {
      __reserved: `0x${'0'.repeat(32)}`,
      deployUrl,
      metaUrl: '',
      mutability: stringToHex(mutability, { size: 16 }),
      owner: '0x1111111111111111111111111111111111111111',
    },
  ]);
}

function build({ mainnet, op } = {}) {
  const allowedCids = new Set();
  const fetchImpl = recordingFetch((url) => {
    if (url === OP_RPC_URL) {
      return jsonResponse({
        id: 1,
        jsonrpc: '2.0',
        result: op ?? packageInfo({ deployUrl: '' }),
      });
    }
    if (url === MAINNET_RPC_URL) {
      return jsonResponse({
        id: 1,
        jsonrpc: '2.0',
        result: mainnet ?? packageInfo({ deployUrl: '' }),
      });
    }
    return undefined;
  });
  return {
    allowedCids,
    fetchImpl,
    registry: createPreviewRegistry({
      allowedCids,
      fetchImpl,
      mainnetRpcUrl: MAINNET_RPC_URL,
      opRpcUrl: OP_RPC_URL,
      previousPackage: {
        cid: PREVIOUS_CID,
        fullPackageRef: 'reya-omnibus:1.0.158@main',
      },
    }),
  };
}

test('answers the pinned previous package without touching a registry', async () => {
  const { fetchImpl, registry } = build({
    op: packageInfo({ deployUrl: `ipfs://${OTHER_CID}` }),
  });
  const resolved = await registry.getUrl('reya-omnibus:1.0.158@main', 1729);

  assert.deepEqual(resolved, {
    mutability: 'version',
    url: `ipfs://${PREVIOUS_CID}`,
  });
  assert.equal(
    fetchImpl.calls.length,
    0,
    'a chain read must not be able to move the pinned baseline',
  );
});

test('resolves other references against OP Mainnet first', async () => {
  const { fetchImpl, registry } = build({
    op: packageInfo({ deployUrl: `ipfs://${PARTIAL_CID}` }),
  });
  const resolved = await registry.getUrl('reya-core:1.0.26@router', 13370);

  assert.deepEqual(resolved, {
    mutability: 'version',
    url: `ipfs://${PARTIAL_CID}`,
  });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, OP_RPC_URL);
  const request = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(request.method, 'eth_call');
  assert.equal(request.params[0].to, CANNON_REGISTRY_ADDRESS);
});

test('falls back to Ethereum Mainnet only when OP has no entry', async () => {
  const { fetchImpl, registry } = build({
    mainnet: packageInfo({ deployUrl: `ipfs://${OTHER_CID}` }),
  });
  const resolved = await registry.getUrl('reya-tokens:1.0.0@proxy', 13370);

  assert.equal(resolved.url, `ipfs://${OTHER_CID}`);
  assert.deepEqual(
    fetchImpl.calls.map(({ url }) => url),
    [OP_RPC_URL, MAINNET_RPC_URL],
  );
});

test('returns null rather than reaching for a hosted fallback', async () => {
  const { registry } = build();

  assert.deepEqual(await registry.getUrl('reya-core:9.9.9@router', 13370), {
    mutability: '',
    url: null,
  });
});

test('caches a resolution so one preview cannot fan out RPC calls', async () => {
  const { fetchImpl, registry } = build({
    op: packageInfo({ deployUrl: `ipfs://${PARTIAL_CID}` }),
  });
  await registry.getUrl('reya-core:1.0.26@router', 13370);
  await registry.getUrl('reya-core:1.0.26@router', 13370);

  assert.equal(fetchImpl.calls.length, 1);
});

test('bounds the number of distinct lookups one preview may make', async () => {
  const { registry } = build();
  for (let index = 0; index < MAX_REGISTRY_LOOKUPS; index += 1) {
    await registry.getUrl(`reya-core:1.0.${index}@router`, 13370);
  }

  await assert.rejects(
    () => registry.getUrl('reya-core:2.0.0@router', 13370),
    (error) => error.code === 'PREVIEW_FAILED',
  );
});

test('passes a content address straight through', async () => {
  const { fetchImpl, registry } = build();

  assert.deepEqual(await registry.getUrl(`ipfs://${OTHER_CID}`, 13370), {
    mutability: '',
    url: `ipfs://${OTHER_CID}`,
  });
  assert.deepEqual(await registry.getUrl(OTHER_CID, 13370), {
    mutability: '',
    url: `ipfs://${OTHER_CID}`,
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('rejects a deployUrl that is not a canonical ipfs CIDv0 URL', async () => {
  const { registry } = build({
    op: packageInfo({ deployUrl: 'https://gateway.pinata.cloud/ipfs/Qm123' }),
  });

  await assert.rejects(
    () => registry.getUrl('reya-core:1.0.26@router', 13370),
    (error) => error.code === 'PREVIEW_FAILED',
  );
});

test('rejects an unrecognised mutability value', async () => {
  const { registry } = build({
    op: packageInfo({
      deployUrl: `ipfs://${PARTIAL_CID}`,
      mutability: 'whatever',
    }),
  });

  await assert.rejects(
    () => registry.getUrl('reya-core:1.0.26@router', 13370),
    (error) => error.code === 'PREVIEW_FAILED',
  );
});

test('refuses to publish a CID this run never produced or verified', async () => {
  const { registry } = build();

  await assert.rejects(
    () =>
      registry.publish(
        ['reya-omnibus:1.0.159@main'],
        1729,
        `ipfs://${OTHER_CID}`,
      ),
    /outside the run/,
  );
});

test('accepts a publish for a CID the run produced, and reads it back', async () => {
  const { allowedCids, registry } = build();
  allowedCids.add(PARTIAL_CID);
  await registry.publish(
    ['reya-omnibus:1.0.159@main'],
    1729,
    `ipfs://${PARTIAL_CID}`,
  );

  assert.deepEqual(await registry.getUrl('reya-omnibus:1.0.159@main', 1729), {
    mutability: 'version',
    url: `ipfs://${PARTIAL_CID}`,
  });
});

test('a publish cannot overwrite the pinned previous package', async () => {
  const { allowedCids, registry } = build();
  allowedCids.add(PARTIAL_CID);

  await assert.rejects(
    () =>
      registry.publish(
        ['reya-omnibus:1.0.158@main'],
        1729,
        `ipfs://${PARTIAL_CID}`,
      ),
    /targets a pinned package/,
  );
  assert.equal(
    (await registry.getUrl('reya-omnibus:1.0.158@main', 1729)).url,
    `ipfs://${PREVIOUS_CID}`,
  );
});

test('normalises package references the way Cannon does', () => {
  assert.deepEqual(parsePackageReference('reya-core'), {
    fullPackageRef: 'reya-core:latest@main',
    name: 'reya-core',
    preset: 'main',
    version: 'latest',
  });
  assert.equal(
    parsePackageReference('reya-core:1.0.0').fullPackageRef,
    'reya-core:1.0.0@main',
  );
  assert.equal(parsePackageReference(`${'a'.repeat(33)}:1.0.0@main`), null);
  assert.equal(
    parsePackageReference('reya-core:1.0.0@' + 'p'.repeat(25)),
    null,
  );
  assert.equal(parsePackageReference('reya core:1.0.0@main'), null);
  assert.equal(parsePackageReference('-core:1.0.0@main'), null);
});
