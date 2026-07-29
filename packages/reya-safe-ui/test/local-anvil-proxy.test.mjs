import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createRpcRequest,
  createUpstreamProxy,
} from '../test-support/local-anvil-fork.mjs';

async function fakeUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('upstream proxy retries transient statuses and returns the exact RPC result', async (context) => {
  let attempts = 0;
  const upstream = await fakeUpstream((request, response) => {
    attempts += 1;
    request.resume();
    if (attempts < 3) {
      response.writeHead(503).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"jsonrpc":"2.0","id":1,"result":"0x6c1"}');
  });
  const proxy = await createUpstreamProxy(upstream.origin);
  context.after(async () => {
    await proxy.close();
    await upstream.close();
  });

  assert.equal(
    await createRpcRequest(proxy.origin)({ method: 'eth_chainId' }),
    '0x6c1'
  );
  assert.equal(attempts, 3);
});

test('upstream proxy does not retry a non-transient status', async (context) => {
  let attempts = 0;
  const upstream = await fakeUpstream((request, response) => {
    attempts += 1;
    request.resume();
    response.writeHead(401).end();
  });
  const proxy = await createUpstreamProxy(upstream.origin);
  context.after(async () => {
    await proxy.close();
    await upstream.close();
  });

  await assert.rejects(
    () => createRpcRequest(proxy.origin)({ method: 'eth_chainId' }),
    /eth_chainId transport failed/
  );
  assert.equal(attempts, 1);
});

test('upstream proxy bounds retryable failures to four attempts', async (context) => {
  let attempts = 0;
  const upstream = await fakeUpstream((request, response) => {
    attempts += 1;
    request.resume();
    response.writeHead(503).end();
  });
  const proxy = await createUpstreamProxy(upstream.origin);
  context.after(async () => {
    await proxy.close();
    await upstream.close();
  });

  await assert.rejects(
    () => createRpcRequest(proxy.origin)({ method: 'eth_chainId' }),
    /eth_chainId transport failed/
  );
  assert.equal(attempts, 4);
});

test('closing the proxy aborts a stalled upstream request promptly', async (context) => {
  let started;
  const requestStarted = new Promise((resolve) => {
    started = resolve;
  });
  const upstream = await fakeUpstream((request) => {
    request.resume();
    started();
  });
  const proxy = await createUpstreamProxy(upstream.origin);
  context.after(async () => {
    await proxy.close();
    await upstream.close();
  });

  const pending = createRpcRequest(proxy.origin)({
    method: 'eth_chainId',
  });
  await requestStarted;
  const before = Date.now();
  await proxy.close();
  await assert.rejects(pending, /eth_chainId transport failed/);
  assert.ok(Date.now() - before < 2_000);
});

test('RPC errors never echo an upstream URL or bare token', async (context) => {
  const upstream = await fakeUpstream((request, response) => {
    request.resume();
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"https://provider.invalid/private-token bare-private-token"}}'
      );
  });
  const proxy = await createUpstreamProxy(upstream.origin);
  context.after(async () => {
    await proxy.close();
    await upstream.close();
  });

  await assert.rejects(
    () => createRpcRequest(proxy.origin)({ method: 'eth_chainId' }),
    (error) => {
      assert.equal(
        error.message,
        'local fork RPC eth_chainId failed with code -32000'
      );
      return true;
    }
  );
});
