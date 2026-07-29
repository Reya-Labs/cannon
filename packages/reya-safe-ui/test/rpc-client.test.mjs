import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REYA_READ_LIMITS,
  ReyaReadClientError,
  RPC_ROUTE_PATH,
} from '../src/clients/index.mjs';
import {
  clientWith,
  jsonResponse,
  SERVICE_ORIGIN,
} from '../test-support/client-fixtures.mjs';

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('posts one canonical read to the fixed Reya RPC route', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ options, request, url });
    return jsonResponse({
      id: request.id,
      jsonrpc: '2.0',
      result:
        request.method === 'eth_chainId'
          ? '0x6c1'
          : { number: '0x1', transactions: [] },
    });
  });

  assert.equal(
    await client.rpc.read({ method: 'eth_chainId', params: [] }),
    '0x6c1'
  );
  const block = await client.rpc.read({
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  });

  assert.deepEqual(block, { number: '0x1', transactions: [] });
  assert.ok(Object.isFrozen(block));
  assert.ok(Object.isFrozen(block.transactions));
  assert.deepEqual(
    requests.map(({ request }) => request.id),
    [1, 2]
  );
  for (const { options, request, url } of requests) {
    assert.equal(url, `${SERVICE_ORIGIN}${RPC_ROUTE_PATH}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal('Authorization' in options.headers, false);
    assert.deepEqual(Object.keys(request), ['id', 'jsonrpc', 'method', 'params']);
    assert.equal(request.jsonrpc, '2.0');
  }
});

for (const input of [
  [],
  null,
  { method: 'eth_chainId', params: [], url: 'https://rpc.example' },
  { method: 'eth_sendRawTransaction', params: ['0x00'] },
  { method: 'eth_chainId', params: {} },
]) {
  test(`rejects RPC input outside the finite contract ${JSON.stringify(input)}`, async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      throw new Error('must not fetch');
    });

    await assert.rejects(
      () => client.rpc.read(input),
      assertClientError('INVALID_INPUT')
    );
    assert.equal(calls, 0);
  });
}

test('rejects symbol-keyed, cyclic, and oversized RPC input before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('must not fetch');
  });
  const symbolKeyed = { method: 'eth_chainId', params: [] };
  symbolKeyed[Symbol('credential')] = 'secret';
  const cyclic = [];
  cyclic.push(cyclic);

  for (const input of [
    symbolKeyed,
    { method: 'eth_call', params: cyclic },
    {
      method: 'eth_call',
      params: ['x'.repeat(REYA_READ_LIMITS.rpcRequestBytes)],
    },
  ]) {
    await assert.rejects(
      () => client.rpc.read(input),
      assertClientError('INVALID_INPUT')
    );
  }
  assert.equal(calls, 0);
});

test('rejects accessor-backed RPC framing and parameters before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('must not fetch');
  });
  let methodReads = 0;
  const mutableMethod = {
    get method() {
      methodReads += 1;
      return methodReads === 1 ? 'eth_chainId' : 'eth_sendRawTransaction';
    },
    params: [],
  };
  const mutableParams = { method: 'eth_chainId' };
  Object.defineProperty(mutableParams, 'params', {
    enumerable: true,
    get() {
      return [];
    },
  });
  const nestedAccessor = { method: 'eth_call', params: [{}] };
  Object.defineProperty(nestedAccessor.params[0], 'to', {
    enumerable: true,
    get() {
      return '0x0000000000000000000000000000000000000001';
    },
  });

  for (const input of [mutableMethod, mutableParams, nestedAccessor]) {
    await assert.rejects(
      () => client.rpc.read(input),
      assertClientError('INVALID_INPUT')
    );
  }
  assert.equal(calls, 0);
  assert.equal(methodReads, 0);
});

test('binds the RPC response to the exact request ID and success schema', async () => {
  const responses = [
    { id: 2, jsonrpc: '2.0', result: '0x6c1' },
    {
      error: { code: -32_000, message: 'upstream failure' },
      id: 2,
      jsonrpc: '2.0',
    },
    { extra: true, id: 3, jsonrpc: '2.0', result: '0x6c1' },
    [{ id: 4, jsonrpc: '2.0', result: '0x6c1' }],
  ];
  const client = clientWith(async () => jsonResponse(responses.shift()));

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(
      () => client.rpc.read({ method: 'eth_chainId', params: [] }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('rejects duplicate keys, non-canonical JSON, and forbidden result keys', async () => {
  const bodies = [
    '{"id":1,"jsonrpc":"2.0","result":"0x1","result":"0x2"}',
    '{ "id": 2, "jsonrpc": "2.0", "result": "0x6c1" }',
    '{"id":3,"jsonrpc":"2.0","result":{"__proto__":"blocked"}}',
  ];
  const client = clientWith(async () =>
    jsonResponse(bodies.shift(), { contentLength: false })
  );

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      () => client.rpc.read({ method: 'eth_chainId', params: [] }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('enforces the RPC response byte cap', async () => {
  const client = clientWith(async () =>
    jsonResponse({ id: 1, jsonrpc: '2.0', result: '0x1' }, {
      headers: {
        'content-length': String(REYA_READ_LIMITS.rpcResponseBytes + 1),
      },
    })
  );

  await assert.rejects(
    () => client.rpc.read({ method: 'eth_chainId', params: [] }),
    assertClientError('RESPONSE_REJECTED')
  );
});
