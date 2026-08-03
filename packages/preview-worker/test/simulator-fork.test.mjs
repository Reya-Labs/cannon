import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createForkRequest,
  createPreviewFork,
  createUpstreamProxy,
  detectPrunedState,
  EXPECTED_ANVIL_VERSION,
  PRUNED_STATE_SCAN_BYTES,
  verifyAnvilRuntime,
} from '../src/simulator/fork.mjs';
import { RPC_URL, SAFE_ADDRESS } from './simulator-support.mjs';

const PRUNED_ERROR = {
  code: -32000,
  message: 'missing trie node 0xabc (path ) state is not available',
};

function encode(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function withJsonRpcServer(respond, run) {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = respond(body);
      const payload = Buffer.from(JSON.stringify(value));
      response.writeHead(200, {
        'content-length': String(payload.byteLength),
        'content-type': 'application/json',
      });
      response.end(payload);
    });
  });
  await new Promise((resolve) =>
    server.listen({ host: '127.0.0.1', port: 0 }, resolve),
  );
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function code(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

test('recognises a pruned-state rejection in a raw upstream body', () => {
  assert.equal(
    detectPrunedState(encode({ error: PRUNED_ERROR, id: 1, jsonrpc: '2.0' })),
    true,
  );
  assert.equal(
    detectPrunedState(
      encode([
        { id: 1, jsonrpc: '2.0', result: '0x1' },
        { error: PRUNED_ERROR, id: 2, jsonrpc: '2.0' },
      ]),
    ),
    true,
    'a batched rejection must count too',
  );
});

test('does not mistake an ordinary rejection for pruned state', () => {
  assert.equal(
    detectPrunedState(
      encode({
        error: { code: -32000, message: 'execution reverted' },
        id: 1,
        jsonrpc: '2.0',
      }),
    ),
    false,
  );
  assert.equal(detectPrunedState(encode({ id: 1, result: '0x1' })), false);
  assert.equal(detectPrunedState(new Uint8Array(0)), false);
});

test('bounds the pruned-state scan so a large result is not re-decoded', () => {
  const padded = {
    error: PRUNED_ERROR,
    id: 1,
    jsonrpc: '2.0',
    result: 'x'.repeat(PRUNED_STATE_SCAN_BYTES),
  };

  assert.equal(detectPrunedState(encode(padded)), false);
});

test('refuses any Anvil but the pinned build', async () => {
  const execFileImpl = (_binary, _args, _options, callback) =>
    callback(null, 'anvil Version: 1.1.0-v1.1.0\nCommit SHA: deadbeef\n');

  assert.equal(await code(verifyAnvilRuntime(execFileImpl)), 'PREVIEW_FAILED');
  assert.equal(
    await code(
      verifyAnvilRuntime((_binary, _args, _options, callback) =>
        callback(null, `${EXPECTED_ANVIL_VERSION}Build Timestamp: 2025\n`),
      ),
    ),
    null,
  );
});

test('fails closed when Foundry is not installed at all', async () => {
  const execFileImpl = (_binary, _args, _options, callback) =>
    callback(new Error('spawn anvil ENOENT'));

  assert.equal(await code(verifyAnvilRuntime(execFileImpl)), 'PREVIEW_FAILED');
});

test('the upstream proxy forwards a call and never echoes the upstream URL', async () => {
  const seen = [];
  const proxy = await createUpstreamProxy({
    fetchImpl: async (url, options) => {
      seen.push({ body: options.body.toString('utf8'), url });
      return {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              encode({ id: 1, jsonrpc: '2.0', result: '0x6c1' }),
            );
            controller.close();
          },
        }),
        headers: new Headers({ 'content-type': 'application/json' }),
        ok: true,
        status: 200,
      };
    },
    upstream: RPC_URL,
  });
  try {
    const request = createForkRequest(proxy.origin);
    assert.equal(await request({ method: 'eth_chainId' }), '0x6c1');
    assert.equal(seen[0].url, RPC_URL);
    assert.equal(proxy.prunedState, false);

    const raw = await fetch(proxy.origin, {
      body: JSON.stringify({ id: 9, jsonrpc: '2.0', method: 'eth_chainId' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal((await raw.text()).includes('token'), false);
  } finally {
    await proxy.close();
  }
});

test('the upstream proxy records a mid-build pruned-state rejection', async () => {
  const proxy = await createUpstreamProxy({
    fetchImpl: async () => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            encode({ error: PRUNED_ERROR, id: 1, jsonrpc: '2.0' }),
          );
          controller.close();
        },
      }),
      headers: new Headers({ 'content-type': 'application/json' }),
      ok: true,
      status: 200,
    }),
    upstream: RPC_URL,
  });
  try {
    await fetch(proxy.origin, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_getBalance' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    assert.equal(proxy.prunedState, true);
  } finally {
    await proxy.close();
  }
});

test('the upstream proxy answers nothing but a JSON-RPC POST at the root', async () => {
  const proxy = await createUpstreamProxy({
    fetchImpl: async () => {
      throw new Error('upstream must not be reached');
    },
    upstream: RPC_URL,
  });
  try {
    for (const request of [
      { method: 'GET' },
      { headers: { 'content-type': 'text/plain' }, method: 'POST' },
    ]) {
      const response = await fetch(proxy.origin, {
        body: request.method === 'POST' ? '{}' : undefined,
        headers: request.headers,
        method: request.method,
      });
      assert.equal(response.status, 404);
    }
    const wrongPath = await fetch(`${proxy.origin}/rpc`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    assert.equal(wrongPath.status, 404);
  } finally {
    await proxy.close();
  }
});

test('a fork RPC turns a pruned-state rejection into the fail-closed contract', async () => {
  await withJsonRpcServer(
    (body) => ({ error: PRUNED_ERROR, id: body.id, jsonrpc: '2.0' }),
    async (origin) => {
      const request = createForkRequest(origin);
      assert.equal(
        await code(request({ method: 'eth_getBalance', params: [] })),
        'RPC_PINNED_STATE_UNAVAILABLE',
      );
    },
  );
});

test('a fork RPC leaves an ordinary rejection legible to the builder', async () => {
  await withJsonRpcServer(
    (body) => ({
      error: { code: 3, message: 'execution reverted' },
      id: body.id,
      jsonrpc: '2.0',
    }),
    async (origin) => {
      const request = createForkRequest(origin);
      await assert.rejects(
        () => request({ method: 'eth_call', params: [] }),
        /preview fork RPC eth_call was rejected/,
      );
    },
  );
});

test('a fork RPC refuses a response whose id does not match the request', async () => {
  await withJsonRpcServer(
    () => ({ id: 99, jsonrpc: '2.0', result: '0x1' }),
    async (origin) => {
      const request = createForkRequest(origin);
      assert.equal(
        await code(request({ method: 'eth_chainId' })),
        'PREVIEW_FAILED',
      );
    },
  );
});

test('the fork refuses to start against the wrong chain', async () => {
  assert.equal(
    await code(
      createPreviewFork({
        fetchImpl: async () => ({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                encode({ id: 1, jsonrpc: '2.0', result: '0x1' }),
              );
              controller.close();
            },
          }),
          headers: new Headers({ 'content-type': 'application/json' }),
          ok: true,
          status: 200,
        }),
        safeAddress: SAFE_ADDRESS,
        upstreamRpcUrl: RPC_URL,
        verifyRuntime: async () => undefined,
      }),
    ),
    'PREVIEW_FAILED',
  );
});

test('the fork fails closed when the upstream cannot serve the pinned block', async () => {
  let call = 0;
  const responses = [
    { id: 1, jsonrpc: '2.0', result: '0x6c1' },
    {
      id: 2,
      jsonrpc: '2.0',
      result: { hash: `0x${'b'.repeat(64)}`, number: '0x1220f0' },
    },
    { error: PRUNED_ERROR, id: 3, jsonrpc: '2.0' },
  ];

  assert.equal(
    await code(
      createPreviewFork({
        fetchImpl: async () => {
          const value = responses[call];
          call += 1;
          return {
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(encode(value));
                controller.close();
              },
            }),
            headers: new Headers({ 'content-type': 'application/json' }),
            ok: true,
            status: 200,
          };
        },
        safeAddress: SAFE_ADDRESS,
        upstreamRpcUrl: RPC_URL,
        verifyRuntime: async () => undefined,
      }),
    ),
    'RPC_PINNED_STATE_UNAVAILABLE',
  );
  assert.equal(call, 3, 'Anvil must never be spawned once the probe fails');
});

test('the fork surfaces a missing Foundry runtime as a preview failure', async () => {
  assert.equal(
    await code(
      createPreviewFork({
        safeAddress: SAFE_ADDRESS,
        upstreamRpcUrl: RPC_URL,
        verifyRuntime: async () => {
          const { PreviewError } = await import('../src/errors.mjs');
          throw new PreviewError(502, 'PREVIEW_FAILED');
        },
      }),
    ),
    'PREVIEW_FAILED',
  );
});

test('the pruned-state detector parses the original bytes, not a folded copy', () => {
  // The marker match is case-insensitive; the JSON it then parses is not
  // case-folded, so a mixed-case payload is still read as it was sent.
  const body = encode({
    error: { code: -32000, message: 'Missing Trie Node 0xABC' },
    id: 1,
    jsonrpc: '2.0',
  });

  assert.equal(detectPrunedState(body), true);
});
