import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalAnvilFork,
  selectPinnedForkBlock,
  verifyAnvilRuntime,
} from '../test-support/local-anvil-fork.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'a'.repeat(64)}`;

test('selects finalized state and proves the exact numeric block is readable', async () => {
  const calls = [];
  const block = await selectPinnedForkBlock({
    safeAddress: SAFE,
    async request(value) {
      calls.push(value);
      if (value.method === 'eth_getBlockByNumber') {
        return { hash: HASH, number: '0x2a' };
      }
      return '0x0';
    },
  });

  assert.deepEqual(block, {
    blockHash: HASH,
    blockNumber: '42',
    mode: 'upstream-finalized',
  });
  assert.deepEqual(calls, [
    {
      method: 'eth_getBlockByNumber',
      params: ['finalized', false],
    },
    {
      method: 'eth_getBalance',
      params: [SAFE, '0x2a'],
    },
  ]);
});

test('rejects a malformed finalized block and an upstream without history', async () => {
  await assert.rejects(
    () =>
      selectPinnedForkBlock({
        safeAddress: SAFE,
        async request() {
          return { hash: HASH, number: '42' };
        },
      }),
    /upstream cannot serve finalized state/
  );

  await assert.rejects(
    () =>
      selectPinnedForkBlock({
        safeAddress: SAFE,
        async request({ method }) {
          if (method === 'eth_getBlockByNumber') {
            return { hash: HASH, number: '0x2a' };
          }
          throw new Error('numeric state unavailable');
        },
      }),
    /upstream cannot serve finalized state/
  );
});

test('reuses one explicit block only after verifying its number and hash', async () => {
  const calls = [];
  const block = await selectPinnedForkBlock({
    forkBlock: {
      blockHash: HASH,
      blockNumber: '42',
    },
    safeAddress: SAFE,
    async request(value) {
      calls.push(value);
      if (value.method === 'eth_getBlockByNumber') {
        return { hash: HASH, number: '0x2a' };
      }
      return '0x0';
    },
  });

  assert.deepEqual(block, {
    blockHash: HASH,
    blockNumber: '42',
    mode: 'explicit-pinned',
  });
  assert.equal(calls[0].params[0], '0x2a');

  await assert.rejects(
    () =>
      selectPinnedForkBlock({
        forkBlock: {
          blockHash: `0x${'b'.repeat(64)}`,
          blockNumber: '42',
        },
        safeAddress: SAFE,
        async request() {
          return { hash: HASH, number: '0x2a' };
        },
      }),
    /upstream cannot serve finalized state/
  );
});

test('accepts only the pinned Anvil build with bounded fixed invocation', async () => {
  let observed;
  await verifyAnvilRuntime((file, args, options, callback) => {
    observed = { args, file, options };
    callback(
      null,
      'anvil Version: 1.2.3-v1.2.3\n' +
        'Commit SHA: a813a2cee7dd4926e7c56fd8a785b54f32e0d10f\n' +
        'Build Timestamp: ignored\n'
    );
  });
  assert.equal(observed.file, 'anvil');
  assert.deepEqual(observed.args, ['--version']);
  assert.deepEqual(Object.keys(observed.options).sort(), [
    'encoding',
    'env',
    'maxBuffer',
    'timeout',
    'windowsHide',
  ]);

  for (const output of [
    'anvil Version: 1.2.4\nCommit SHA: wrong\n',
    `${
      'anvil Version: 1.2.3-v1.2.3\n' +
      'Commit SHA: a813a2cee7dd4926e7c56fd8a785b54f32e0d10f\n'
    }${'x'.repeat(4_096)}`,
  ]) {
    await assert.rejects(
      () =>
        verifyAnvilRuntime((_file, _args, _options, callback) => {
          callback(null, output);
        }),
      /required local Anvil runtime is unavailable/
    );
  }
});

test('rejects an interrupted fork before starting Anvil', async () => {
  const lifecycle = new AbortController();
  lifecycle.abort();
  await assert.rejects(
    createLocalAnvilFork({
      safeAddress: SAFE,
      signal: lifecycle.signal,
      upstreamRpcUrl: 'https://rpc.example.invalid/token',
    }),
    /local fork lifecycle is invalid/
  );
});
