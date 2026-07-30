import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalIngress,
  loadLocalIngressConfig,
} from '../src/local-ingress.mjs';
import { encodeFunctionResult, stringToHex } from 'viem';
import { OP_REGISTRY_GET_PACKAGE_INFO_ABI } from '../src/runtime/op-registry-resolver.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const PARTIAL_COMMIT = '89abcdef0123456789abcdef0123456789abcdef';
const UI_ORIGIN = 'http://127.0.0.1:3000';
const SECRET = 'local-test-secret-with-at-least-32-bytes';

function config(overrides = {}) {
  return {
    artifactOrigin: 'http://127.0.0.1:8083',
    identity: 'local-test-user',
    opRpcUrl: 'https://optimism.example.test/private',
    port: 0,
    proxySecret: SECRET,
    rpcUrl: 'https://rpc.example.test/private',
    safeAddress: SAFE,
    sourceCommit: COMMIT,
    sourceOrigin: 'http://127.0.0.1:8082',
    uiOrigin: UI_ORIGIN,
    ...overrides,
  };
}

function rpcResponse(request, result) {
  return new Response(
    JSON.stringify({
      id: request.id,
      jsonrpc: '2.0',
      result,
    }),
    {
      headers: { 'content-type': 'application/json' },
      status: 200,
    }
  );
}

test('local ingress exposes only bounded review reads and injects source identity', async (t) => {
  const observed = [];
  const previewRequests = [];
  const previewRunner = {
    allowsSourceCommit(commit) {
      return commit === COMMIT || commit === PARTIAL_COMMIT;
    },
    close() {},
    async run(encoded) {
      previewRequests.push(encoded);
      return {
        chainId: 1729,
        type: 'reya-cannon-read-only-preview',
      };
    },
  };
  const fetchImpl = async (url, init) => {
    if (url === 'https://rpc.example.test/private') {
      const request = JSON.parse(init.body);
      observed.push({ init, request, url });
      return rpcResponse(request, '0x6c1');
    }
    if (url === 'https://optimism.example.test/private') {
      const request = JSON.parse(init.body);
      observed.push({ init, request, url });
      if (request.method === 'eth_chainId') {
        return rpcResponse(request, '0xa');
      }
      return rpcResponse(
        request,
        encodeFunctionResult({
          abi: OP_REGISTRY_GET_PACKAGE_INFO_ABI,
          functionName: 'getPackageInfo',
          result: {
            __reserved: `0x${'0'.repeat(32)}`,
            deployUrl: 'ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
            metaUrl: '',
            mutability: stringToHex('tag', { size: 16 }),
            owner: '0x1111111111111111111111111111111111111111',
          },
        })
      );
    }
    if (
      String(url) ===
      'http://127.0.0.1:8083/api/v0/cat?arg=QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
    ) {
      observed.push({ init, url: String(url) });
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream' },
        status: 200,
      });
    }
    observed.push({ init, url });
    return new Response('[]', {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  };
  const ingress = await createLocalIngress(config(), {
    fetchImpl,
    previewRunner,
  });
  t.after(() => ingress.close());
  const address = ingress.server.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const beforeStaging = observed.length;
  for (const options of [
    { headers: { origin: UI_ORIGIN } },
    {
      body: '{}',
      headers: {
        'content-type': 'application/json',
        origin: UI_ORIGIN,
      },
      method: 'POST',
    },
  ]) {
    const staging = await fetch(`${origin}/staging/1729/${SAFE}`, options);
    assert.equal(staging.status, 404);
  }
  const stagingPreflight = await fetch(`${origin}/staging/1729/${SAFE}`, {
    headers: {
      'access-control-request-headers': 'content-type',
      'access-control-request-method': 'POST',
      origin: UI_ORIGIN,
    },
    method: 'OPTIONS',
  });
  assert.equal(stagingPreflight.status, 404);
  assert.equal(observed.length, beforeStaging);

  const rpcRead = await fetch(`${origin}/rpc/1729`, {
    body: JSON.stringify({
      id: 2,
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    }),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(rpcRead.status, 200);
  assert.deepEqual(await rpcRead.json(), {
    id: 2,
    jsonrpc: '2.0',
    result: '0x6c1',
  });

  const previewRequest = {
    chainId: 1729,
    commit: COMMIT,
    partialDeployCid: null,
    previousPackageCid: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
    safeAddress: SAFE,
  };
  const preview = await fetch(`${origin}/preview/1729`, {
    body: JSON.stringify(previewRequest),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    chainId: 1729,
    type: 'reya-cannon-read-only-preview',
  });
  assert.deepEqual(previewRequests, [JSON.stringify(previewRequest)]);

  const oversizedPreview = await fetch(`${origin}/preview/1729`, {
    body: JSON.stringify({ padding: 'x'.repeat(1_024) }),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(oversizedPreview.status, 413);
  assert.equal(previewRequests.length, 1);

  const registry = await fetch(`${origin}/registry/op/resolve`, {
    body: JSON.stringify({
      chainId: 1729,
      packageRef: 'reya-omnibus:latest@main',
    }),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(registry.status, 200);
  assert.deepEqual(await registry.json(), {
    chainId: 1729,
    cid: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
    deployUrl: 'ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
    found: true,
    mutability: 'tag',
    packageRef: 'reya-omnibus:latest@main',
    registryAddress: '0x8e5c7efc9636a6a0408a46bb7f617094b81e5dba',
    registryChainId: 10,
    schemaVersion: 1,
  });
  assert.equal(observed.at(-1).url, 'https://optimism.example.test/private');
  assert.equal(observed.at(-1).request.method, 'eth_call');

  const beforeDuplicateRegistry = observed.length;
  const duplicateRegistry = await fetch(`${origin}/registry/op/resolve`, {
    body: `{"chainId":1729,"chainId":1729,"packageRef":"reya-omnibus:latest@main"}`,
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(duplicateRegistry.status, 400);
  assert.equal(observed.length, beforeDuplicateRegistry);

  const artifact = await fetch(
    `${origin}/artifacts/api/v0/cat?arg=QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn`,
    {
      headers: { origin: UI_ORIGIN },
      method: 'POST',
    }
  );
  assert.equal(artifact.status, 200);
  assert.deepEqual(
    new Uint8Array(await artifact.arrayBuffer()),
    new Uint8Array([1, 2, 3])
  );
  assert.equal(
    observed.at(-1).url,
    'http://127.0.0.1:8083/api/v0/cat?arg=QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'
  );

  const source = await fetch(
    `${origin}/source/reya-deployments/${COMMIT}/reya-network`,
    { headers: { origin: UI_ORIGIN } }
  );
  assert.equal(source.status, 200);
  assert.equal(
    observed.at(-1).url,
    `http://127.0.0.1:8082/source/reya-deployments/${COMMIT}/reya-network`
  );
  assert.equal(observed.at(-1).init.headers['x-reya-proxy-secret'], SECRET);
  assert.equal(observed.at(-1).init.headers['x-reya-user'], 'local-test-user');
  assert.equal(observed.at(-1).init.headers['x-reya-roles'], undefined);

  const partialSource = await fetch(
    `${origin}/source/reya-deployments/${PARTIAL_COMMIT}/reya-network`,
    { headers: { origin: UI_ORIGIN } }
  );
  assert.equal(partialSource.status, 200);
  assert.equal(
    observed.at(-1).url,
    `http://127.0.0.1:8082/source/reya-deployments/${PARTIAL_COMMIT}/reya-network`
  );

  const beforeUnpinnedSource = observed.length;
  const unpinnedSource = await fetch(
    `${origin}/source/reya-deployments/${'f'.repeat(40)}/reya-network`,
    { headers: { origin: UI_ORIGIN } }
  );
  assert.equal(unpinnedSource.status, 404);
  assert.equal(observed.length, beforeUnpinnedSource);

  const before = observed.length;
  const supersede = await fetch(`${origin}/staging/1729/${SAFE}/supersede`, {
    headers: { origin: UI_ORIGIN },
  });
  assert.equal(supersede.status, 404);
  assert.equal(observed.length, before);

  const wrongSafe = await fetch(
    `${origin}/staging/1729/0x2222222222222222222222222222222222222222`,
    {
      headers: { origin: UI_ORIGIN },
    }
  );
  assert.equal(wrongSafe.status, 404);
  assert.equal(observed.length, before);

  const unknownPreflight = await fetch(`${origin}/not-a-route`, {
    headers: {
      'access-control-request-method': 'POST',
      origin: UI_ORIGIN,
    },
    method: 'OPTIONS',
  });
  assert.equal(unknownPreflight.status, 404);
  assert.deepEqual(await unknownPreflight.json(), {
    error: {
      code: 'not_found',
      message: 'local request rejected',
    },
  });
  assert.equal(observed.length, before);

  const wrongMediaType = await fetch(`${origin}/rpc/1729`, {
    body: '{}',
    headers: {
      'content-type': 'text/plain',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(wrongMediaType.status, 400);
  assert.deepEqual(await wrongMediaType.json(), {
    error: {
      code: 'request_rejected',
      message: 'local request rejected',
    },
  });
  assert.equal(observed.length, before);

  const write = await fetch(`${origin}/rpc/1729`, {
    body: JSON.stringify({
      id: 3,
      jsonrpc: '2.0',
      method: 'eth_sendTransaction',
      params: [],
    }),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(write.status, 400);
  assert.equal(observed.length, before);

  const wrongOrigin = await fetch(`${origin}/rpc/1729`, {
    body: JSON.stringify({
      id: 4,
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    }),
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3001',
    },
    method: 'POST',
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(observed.length, before);
});

test('local ingress refuses to listen when the upstream is not Reya Network', async () => {
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    return rpcResponse(request, '0x1');
  };

  await assert.rejects(
    createLocalIngress(config(), { fetchImpl }),
    /RPC upstream is not Reya Network/
  );
});

test('local ingress refuses an OP registry RPC that is not OP Mainnet', async () => {
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    return rpcResponse(
      request,
      url === 'https://rpc.example.test/private' ? '0x6c1' : '0x1'
    );
  };

  await assert.rejects(
    createLocalIngress(config(), { fetchImpl }),
    /OP RPC upstream is not OP Mainnet/
  );
});

test('local ingress degrades aliases closed and strictly bounds artifact reads', async (t) => {
  const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
  let artifactMode = 'ok';
  let artifactCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url === 'https://rpc.example.test/private') {
      const request = JSON.parse(init.body);
      return rpcResponse(request, '0x6c1');
    }
    if (String(url).includes('/api/v0/cat?arg=')) {
      artifactCalls += 1;
      if (artifactMode === 'wrong-type') {
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }
      if (artifactMode === 'too-large') {
        return new Response(new Uint8Array([1]), {
          headers: {
            'content-length': String(50 * 1024 * 1024 + 1),
            'content-type': 'application/octet-stream',
          },
          status: 200,
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream' },
        status: 200,
      });
    }
    throw new Error('unexpected upstream');
  };
  const ingress = await createLocalIngress(config({ opRpcUrl: null }), {
    fetchImpl,
  });
  t.after(() => ingress.close());
  const address = ingress.server.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const registry = await fetch(`${origin}/registry/op/resolve`, {
    body: JSON.stringify({
      chainId: 1729,
      packageRef: 'reya-omnibus:latest@main',
    }),
    headers: {
      'content-type': 'application/json',
      origin: UI_ORIGIN,
    },
    method: 'POST',
  });
  assert.equal(registry.status, 502);
  assert.equal(artifactCalls, 0);

  const exact = `${origin}/artifacts/api/v0/cat?arg=${cid}`;
  const artifact = await fetch(exact, {
    headers: { origin: UI_ORIGIN },
    method: 'POST',
  });
  assert.equal(artifact.status, 200);
  assert.deepEqual(
    new Uint8Array(await artifact.arrayBuffer()),
    new Uint8Array([1, 2, 3])
  );
  assert.equal(artifactCalls, 1);

  for (const [url, options] of [
    [`${exact}&arg=${cid}`, { headers: { origin: UI_ORIGIN }, method: 'POST' }],
    [
      exact,
      {
        body: '{}',
        headers: {
          'content-type': 'application/json',
          origin: UI_ORIGIN,
        },
        method: 'POST',
      },
    ],
  ]) {
    const rejected = await fetch(url, options);
    assert.equal(rejected.status, 400);
  }
  assert.equal(artifactCalls, 1);

  artifactMode = 'wrong-type';
  assert.equal(
    (
      await fetch(exact, {
        headers: { origin: UI_ORIGIN },
        method: 'POST',
      })
    ).status,
    502
  );
  artifactMode = 'too-large';
  assert.equal(
    (
      await fetch(exact, {
        headers: { origin: UI_ORIGIN },
        method: 'POST',
      })
    ).status,
    502
  );
  assert.equal(artifactCalls, 3);
});

test('local ingress configuration is fixed to loopback and does not expose RPC credentials', () => {
  const env = {
    REYA_CANNON_QA_RPC_URL: 'https://rpc.example.test/private-token',
    REYA_CANNON_OP_RPC_URL: 'https://optimism.example.test/private-token',
    REYA_LOCAL_ARTIFACT_ORIGIN: 'http://127.0.0.1:8083',
    REYA_LOCAL_AUTH_PROXY_SECRET: SECRET,
    REYA_LOCAL_IDENTITY: 'local-test-user',
    REYA_LOCAL_SAFE_ADDRESS: SAFE,
    REYA_LOCAL_SOURCE_COMMIT: COMMIT,
    REYA_LOCAL_UI_ORIGIN: UI_ORIGIN,
  };
  assert.equal(loadLocalIngressConfig(env).port, 8787);
  assert.equal(loadLocalIngressConfig(env).safeAddress, SAFE);
  assert.throws(
    () =>
      loadLocalIngressConfig({
        ...env,
        REYA_LOCAL_UI_ORIGIN: 'http://0.0.0.0:3000',
      }),
    /127\.0\.0\.1/
  );
  assert.throws(
    () =>
      loadLocalIngressConfig({
        ...env,
        REYA_LOCAL_INGRESS_PORT: '8080',
      }),
    /must be 8787/
  );
  assert.throws(
    () =>
      loadLocalIngressConfig({
        ...env,
        REYA_LOCAL_SAFE_ADDRESS: '0x0000000000000000000000000000000000000000',
      }),
    /SAFE_ADDRESS is invalid/
  );
});
