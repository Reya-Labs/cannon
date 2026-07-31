import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionResult, toFunctionSelector } from 'viem';
import { createPreviewRunner } from '../src/preview-runner.mjs';
import { SAFE_STATE_ABI } from '../src/safe-state.mjs';
import { COMMIT, PREVIOUS_CID, SAFE_ADDRESS } from './support.mjs';

const RPC_URL = 'https://rpc.example.invalid/v1/token';
const OWNER_A = '0x00000000000000000000000000000000000000a1';
const OWNER_B = '0x00000000000000000000000000000000000000b2';
const OWNER_C = '0x00000000000000000000000000000000000000c3';

const REQUEST = Object.freeze({
  chainId: 1729,
  commit: COMMIT,
  deploymentMode: 'cannonfile',
  partialDeployCid: null,
  previousPackageCid: PREVIOUS_CID,
  safeAddress: SAFE_ADDRESS,
});

function simulation(overrides = {}) {
  return {
    deployerPrerequisites: [],
    evidence: { mode: 'test' },
    safeAddress: SAFE_ADDRESS,
    safeProposalCalls: [
      {
        data: '0xabcdef01',
        decoded: null,
        from: SAFE_ADDRESS,
        gasUsed: '21000',
        senderRole: 'safe',
        sequence: 0,
        step: 'invoke.upgrade',
        to: '0x00000000000000000000000000000000000000aa',
        transactionHash: `0x${'1'.repeat(64)}`,
        value: '0',
      },
    ],
    ...overrides,
  };
}

const SELECTORS = Object.fromEntries(
  SAFE_STATE_ABI.map((item) => [toFunctionSelector(item), item.name]),
);

/**
 * Answers the four Safe reads the runner makes. `digest` lets a test make the
 * on-chain confirmation disagree with the locally derived hash.
 */
function safeRpc({ digest, error, nonce = 5 } = {}) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    const functionName = SELECTORS[body.params[0].data.slice(0, 10)];
    if (error !== undefined) {
      return jsonResponse({ error, id: 1, jsonrpc: '2.0' });
    }
    const result = encodeFunctionResult({
      abi: SAFE_STATE_ABI,
      functionName,
      result:
        functionName === 'nonce'
          ? BigInt(nonce)
          : functionName === 'getThreshold'
            ? 2n
            : functionName === 'getOwners'
              ? [OWNER_A, OWNER_B, OWNER_C]
              : (digest ?? `0x${'e'.repeat(64)}`),
    });
    return jsonResponse({ id: 1, jsonrpc: '2.0', result });
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

/**
 * Mirrors the runner's own derivation so a test can pre-compute the digest the
 * Safe contract is expected to confirm.
 */
async function digestFor(nonce) {
  const { deriveSafeTransaction } = await import('../src/derive.mjs');
  return deriveSafeTransaction(simulation(), nonce).safeTxHash;
}

test('derives the transaction and digest from chain state, not the request', async () => {
  const expected = await digestFor(5);
  const runner = createPreviewRunner({
    fetchImpl: safeRpc({ digest: expected, nonce: 5 }),
    rpcUrl: RPC_URL,
    simulator: { simulate: async () => simulation() },
  });
  const result = await runner.run(REQUEST);
  assert.equal(result.type, 'reya-cannon-server-preview');
  assert.equal(result.derivation, 'server');
  assert.equal(result.safeTxHash, expected);
  assert.equal(result.txn._nonce, 5);
  assert.equal(result.safe.nonce, 5);
  assert.equal(result.safe.threshold, 2);
  assert.deepEqual(result.safe.owners, [OWNER_A, OWNER_B, OWNER_C].sort());
  assert.equal(result.deployerPrerequisiteCount, 0);
});

test('the simulator never receives the nonce, transaction or digest', async () => {
  let seen;
  const runner = createPreviewRunner({
    fetchImpl: safeRpc({ digest: await digestFor(5) }),
    rpcUrl: RPC_URL,
    simulator: {
      simulate: async (input) => {
        seen = input;
        return simulation();
      },
    },
  });
  await runner.run(REQUEST);
  assert.deepEqual(Object.keys(seen).sort(), [
    'commit',
    'deploymentMode',
    'partialDeployCid',
    'previousPackageCid',
    'safeAddress',
    'signal',
  ]);
});

test('fails closed when the Safe contract disagrees with the derived digest', async () => {
  const runner = createPreviewRunner({
    fetchImpl: safeRpc({ digest: `0x${'f'.repeat(64)}` }),
    rpcUrl: RPC_URL,
    simulator: { simulate: async () => simulation() },
  });
  await assert.rejects(() => runner.run(REQUEST), {
    code: 'SAFE_STATE_UNAVAILABLE',
  });
});

test('fails closed with RPC_PINNED_STATE_UNAVAILABLE on pruned state', async () => {
  for (const error of [
    { code: -32000, message: 'missing trie node 0xabc (path )' },
    { code: -32000, message: 'state is not available for block 123' },
    { code: -32001, message: 'requested historical state is pruned' },
  ]) {
    const runner = createPreviewRunner({
      fetchImpl: safeRpc({ error }),
      rpcUrl: RPC_URL,
      simulator: { simulate: async () => simulation() },
    });
    await assert.rejects(
      () => runner.run(REQUEST),
      { code: 'RPC_PINNED_STATE_UNAVAILABLE' },
      error.message,
    );
  }
});

test('does not degrade a pruned-state failure into a current-state answer', async () => {
  let calls = 0;
  const runner = createPreviewRunner({
    fetchImpl: async (url, options) => {
      calls += 1;
      return safeRpc({
        error: { code: -32000, message: 'missing trie node' },
      })(url, options);
    },
    rpcUrl: RPC_URL,
    simulator: { simulate: async () => simulation() },
  });
  await assert.rejects(() => runner.run(REQUEST), {
    code: 'RPC_PINNED_STATE_UNAVAILABLE',
  });
  // The three Safe state reads are issued together; none is retried against a
  // different block tag after the rejection.
  assert.equal(calls, 3);
});

test('rejects a concurrent preview rather than queueing it', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = createPreviewRunner({
    fetchImpl: safeRpc({ digest: await digestFor(5) }),
    rpcUrl: RPC_URL,
    simulator: {
      simulate: async () => {
        await gate;
        return simulation();
      },
    },
  });
  const first = runner.run(REQUEST);
  await assert.rejects(() => runner.run(REQUEST), { code: 'PREVIEW_BUSY' });
  release();
  await first;
  assert.equal(runner.busy, false);
});

test('collapses an unexpected simulator failure into PREVIEW_FAILED', async () => {
  const runner = createPreviewRunner({
    fetchImpl: safeRpc(),
    rpcUrl: RPC_URL,
    simulator: {
      simulate: async () => {
        throw new Error('anvil fork failed at https://rpc.example/v1/secret');
      },
    },
  });
  await assert.rejects(
    () => runner.run(REQUEST),
    (error) => {
      assert.equal(error.code, 'PREVIEW_FAILED');
      assert.ok(!error.message.includes('secret'));
      return true;
    },
  );
});

test('rejects a simulation bound to a different Safe', async () => {
  const runner = createPreviewRunner({
    fetchImpl: safeRpc(),
    rpcUrl: RPC_URL,
    simulator: {
      simulate: async () => simulation({ safeAddress: `0x${'9'.repeat(40)}` }),
    },
  });
  await assert.rejects(() => runner.run(REQUEST), { code: 'PREVIEW_FAILED' });
});

test('refuses to stage a simulation with deployer prerequisites', async () => {
  const runner = createPreviewRunner({
    fetchImpl: safeRpc(),
    rpcUrl: RPC_URL,
    simulator: {
      simulate: async () =>
        simulation({ deployerPrerequisites: [{ senderRole: 'deployer' }] }),
    },
  });
  await assert.rejects(() => runner.run(REQUEST), {
    code: 'PREVIEW_NOT_STAGEABLE',
  });
});
