import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionResult, stringToHex, zeroAddress } from 'viem';
import {
  createRegistryResolver,
  OP_REGISTRY_ABI,
  OP_REGISTRY_ADDRESS,
} from '../src/registry.mjs';
import { ENV } from './support.mjs';

const OWNER = '0x00000000000000000000000000000000000000a1';
const CID = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';

function registryRpc(entry, capture) {
  return async (url, options) => {
    capture?.({ body: JSON.parse(options.body), url });
    return new Response(
      JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        result: encodeFunctionResult({
          abi: OP_REGISTRY_ABI,
          functionName: 'getPackageInfo',
          result: {
            __reserved: `0x${'0'.repeat(32)}`,
            deployUrl: entry.deployUrl,
            metaUrl: '',
            mutability: stringToHex(entry.mutability ?? 'tag', { size: 16 }),
            owner: entry.owner,
          },
        }),
      }),
      { headers: { 'content-type': 'application/json' }, status: 200 },
    );
  };
}

function resolver(fetchImpl) {
  return createRegistryResolver({
    fetchImpl,
    opRpcUrl: ENV.PREVIEW_OP_RPC_URL,
  });
}

test('resolves a published alias to its exact CID', async () => {
  const resolved = await resolver(
    registryRpc({ deployUrl: `ipfs://${CID}`, owner: OWNER }),
  ).resolve({ packageRef: 'reya-omnibus:latest@main' });
  assert.equal(resolved.found, true);
  assert.equal(resolved.cid, CID);
  assert.equal(resolved.deployUrl, `ipfs://${CID}`);
  assert.equal(resolved.mutability, 'tag');
  assert.equal(resolved.chainId, 1729);
  assert.equal(resolved.registryChainId, 10);
  assert.equal(resolved.registryAddress, OP_REGISTRY_ADDRESS);
});

test('reports an unpublished alias as not found rather than failing', async () => {
  const resolved = await resolver(
    registryRpc({ deployUrl: '', owner: zeroAddress }),
  ).resolve({ packageRef: 'reya-omnibus:9.9.9@main' });
  assert.equal(resolved.found, false);
  assert.equal(resolved.cid, null);
  assert.equal(resolved.deployUrl, null);
});

test('reads the registry contract on the server-held OP endpoint only', async () => {
  let seen;
  await resolver(
    registryRpc({ deployUrl: `ipfs://${CID}`, owner: OWNER }, (value) => {
      seen = value;
    }),
  ).resolve({ packageRef: 'reya-omnibus:1.2.3@main' });
  assert.equal(seen.url, ENV.PREVIEW_OP_RPC_URL);
  assert.equal(seen.body.method, 'eth_call');
  assert.equal(seen.body.params[0].to, OP_REGISTRY_ADDRESS);
  assert.equal(seen.body.params[1], 'latest');
});

test('rejects a deployUrl that is not an exact ipfs CIDv0 reference', async () => {
  for (const deployUrl of [
    'https://gateway.example/ipfs/' + CID,
    'ipfs://' + CID + '/deploy.json',
    'ipfs://bafybeiexample',
    CID,
  ]) {
    await assert.rejects(
      () =>
        resolver(registryRpc({ deployUrl, owner: OWNER })).resolve({
          packageRef: 'reya-omnibus:latest@main',
        }),
      { code: 'REGISTRY_UNAVAILABLE' },
      deployUrl,
    );
  }
});

test('rejects an unrecognised mutability value', async () => {
  await assert.rejects(
    () =>
      resolver(
        registryRpc({
          deployUrl: `ipfs://${CID}`,
          mutability: 'mutable',
          owner: OWNER,
        }),
      ).resolve({ packageRef: 'reya-omnibus:latest@main' }),
    { code: 'REGISTRY_UNAVAILABLE' },
  );
});

test('does not contact OP for a reference outside the alias family', async () => {
  const reject = async () => {
    throw new Error('the OP RPC must not be contacted');
  };
  for (const packageRef of [
    'other-package:latest@main',
    'reya-omnibus:latest@dev',
    'reya-omnibus:@main',
    undefined,
  ]) {
    await assert.rejects(
      () => resolver(reject).resolve({ packageRef }),
      { code: 'INVALID_REQUEST' },
      String(packageRef),
    );
  }
});
