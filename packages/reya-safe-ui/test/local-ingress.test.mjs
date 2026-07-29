import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalIngress,
  loadLocalIngressConfig,
} from '../src/local-ingress.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const UI_ORIGIN = 'http://127.0.0.1:3000';
const SECRET = 'local-test-secret-with-at-least-32-bytes';

function config(overrides = {}) {
  return {
    identity: 'local-test-user',
    port: 0,
    proxySecret: SECRET,
    rpcUrl: 'https://rpc.example.test/private',
    safeAddress: SAFE,
    sourceCommit: COMMIT,
    sourceOrigin: 'http://127.0.0.1:8082',
    stagingOrigin: 'http://127.0.0.1:8081',
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

test('local ingress exposes only bounded reads and injects backend identity', async (t) => {
  const observed = [];
  const fetchImpl = async (url, init) => {
    if (url === 'https://rpc.example.test/private') {
      const request = JSON.parse(init.body);
      observed.push({ init, request, url });
      return rpcResponse(request, '0x6c1');
    }
    observed.push({ init, url });
    return new Response('[]', {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  };
  const ingress = await createLocalIngress(config(), { fetchImpl });
  t.after(() => ingress.close());
  const address = ingress.server.address();
  assert.equal(typeof address, 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  const staged = await fetch(`${origin}/staging/1729/${SAFE}`, {
    headers: {
      origin: UI_ORIGIN,
      'x-reya-proxy-secret': 'browser-attacker-value',
      'x-reya-roles': 'operator',
      'x-reya-user': 'browser-attacker',
    },
  });
  assert.equal(staged.status, 200);
  assert.deepEqual(await staged.json(), []);
  const downstream = observed.at(-1);
  assert.equal(downstream.url, `http://127.0.0.1:8081/1729/${SAFE}`);
  assert.equal(downstream.init.headers['x-reya-proxy-secret'], SECRET);
  assert.equal(downstream.init.headers['x-reya-user'], 'local-test-user');
  assert.equal(downstream.init.headers['x-reya-roles'], 'proposer,signer');

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

  const source = await fetch(
    `${origin}/source/reya-deployments/${COMMIT}/reya-network`,
    { headers: { origin: UI_ORIGIN } }
  );
  assert.equal(source.status, 200);
  assert.equal(
    observed.at(-1).url,
    `http://127.0.0.1:8082/source/reya-deployments/${COMMIT}/reya-network`
  );

  const preflight = await fetch(`${origin}/staging/1729/${SAFE}`, {
    headers: {
      'access-control-request-headers': 'content-type,x-idempotency-key',
      'access-control-request-method': 'POST',
      origin: UI_ORIGIN,
    },
    method: 'OPTIONS',
  });
  assert.equal(preflight.status, 204);

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

test('local ingress configuration is fixed to loopback and does not expose RPC credentials', () => {
  const env = {
    REYA_CANNON_QA_RPC_URL: 'https://rpc.example.test/private-token',
    REYA_LOCAL_AUTH_PROXY_SECRET: SECRET,
    REYA_LOCAL_IDENTITY: 'local-test-user',
    REYA_LOCAL_SAFE_ADDRESS: SAFE,
    REYA_LOCAL_SOURCE_COMMIT: COMMIT,
    REYA_LOCAL_UI_ORIGIN: UI_ORIGIN,
  };
  assert.equal(loadLocalIngressConfig(env).port, 8787);
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
});
