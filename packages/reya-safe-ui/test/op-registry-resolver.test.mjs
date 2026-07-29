import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionResult, stringToHex, zeroAddress } from 'viem';
import {
  OP_REGISTRY_ADDRESS,
  OP_REGISTRY_GET_PACKAGE_INFO_ABI,
  resolveOpRegistryPackage,
} from '../src/runtime/op-registry-resolver.mjs';

const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const RPC = 'https://optimism.example.test/private';

function rpcResult({
  deployUrl = `ipfs://${CID}`,
  mutability = 'tag',
  owner = '0x1111111111111111111111111111111111111111',
} = {}) {
  return encodeFunctionResult({
    abi: OP_REGISTRY_GET_PACKAGE_INFO_ABI,
    functionName: 'getPackageInfo',
    result: {
      __reserved: `0x${'0'.repeat(32)}`,
      deployUrl,
      metaUrl: '',
      mutability: stringToHex(mutability, { size: 16 }),
      owner,
    },
  });
}

function response(result = rpcResult(), options = {}) {
  return new Response(
    JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      result,
    }),
    {
      headers: { 'content-type': 'application/json' },
      status: options.status ?? 200,
    }
  );
}

test('reads only getPackageInfo for Reya chain 1729 from the fixed OP registry', async () => {
  const requests = [];
  const resolved = await resolveOpRegistryPackage({
    fetchImpl: async (url, options) => {
      requests.push({ options, url });
      return response();
    },
    packageRef: 'reya-omnibus:latest@main',
    rpcUrl: RPC,
  });

  assert.deepEqual(resolved, {
    chainId: 1729,
    cid: CID,
    deployUrl: `ipfs://${CID}`,
    found: true,
    mutability: 'tag',
    packageRef: 'reya-omnibus:latest@main',
    registryAddress: OP_REGISTRY_ADDRESS,
    registryChainId: 10,
    schemaVersion: 1,
  });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, RPC);
  assert.equal(body.method, 'eth_call');
  assert.equal(body.params[0].to, OP_REGISTRY_ADDRESS);
  assert.match(body.params[0].data, /^0x[0-9a-f]+$/);
  assert.equal(body.params[1], 'latest');
});

test('returns a canonical unknown result without a fallback request', async () => {
  let calls = 0;
  const resolved = await resolveOpRegistryPackage({
    fetchImpl: async () => {
      calls += 1;
      return response(rpcResult({ deployUrl: '', owner: zeroAddress }));
    },
    packageRef: 'reya-omnibus:9.9.9@main',
    rpcUrl: RPC,
  });

  assert.equal(calls, 1);
  assert.deepEqual(resolved, {
    chainId: 1729,
    cid: null,
    deployUrl: null,
    found: false,
    mutability: null,
    packageRef: 'reya-omnibus:9.9.9@main',
    registryAddress: OP_REGISTRY_ADDRESS,
    registryChainId: 10,
    schemaVersion: 1,
  });
});

test('rejects non-Reya refs before RPC and malformed registry responses', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      resolveOpRegistryPackage({
        fetchImpl: async () => {
          calls += 1;
          return response();
        },
        packageRef: 'other:latest@main',
        rpcUrl: RPC,
      }),
    /package reference is invalid/
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () =>
      resolveOpRegistryPackage({
        fetchImpl: async () => {
          calls += 1;
          return response();
        },
        packageRef: `reya-omnibus:1.2.3-${'a'.repeat(27)}@main`,
        rpcUrl: RPC,
      }),
    /package reference is invalid/
  );
  assert.equal(calls, 0);

  for (const result of [
    '0x',
    rpcResult({
      deployUrl: `https://repo.usecannon.com/api/v0/cat?arg=${CID}`,
    }),
    rpcResult({ mutability: 'mutable' }),
  ]) {
    await assert.rejects(
      () =>
        resolveOpRegistryPackage({
          fetchImpl: async () => response(result),
          packageRef: 'reya-omnibus:latest@main',
          rpcUrl: RPC,
        }),
      /response is invalid/
    );
  }
});

test('redacts OP transport failures', async () => {
  await assert.rejects(
    () =>
      resolveOpRegistryPackage({
        fetchImpl: async () => {
          throw new Error(`failed ${RPC}`);
        },
        packageRef: 'reya-omnibus:latest@main',
        rpcUrl: RPC,
      }),
    (error) => {
      assert.equal(error.message, 'OP registry is unavailable');
      assert.doesNotMatch(error.message, /private|optimism/);
      return true;
    }
  );
});
