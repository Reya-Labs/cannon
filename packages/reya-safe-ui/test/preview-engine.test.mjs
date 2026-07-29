import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOrderedRpcRequest,
  createPreviewResult,
} from '../src/runtime/preview-engine.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const DEPLOYER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH = `0x${'12'.repeat(32)}`;

function captured(overrides = {}) {
  return {
    hash: HASH,
    step: 'invoke.upgrade',
    receipt: {
      gasUsed: 100n,
      from: SAFE,
      status: 'success',
      to: TARGET,
      transactionHash: HASH,
    },
    transaction: {
      from: SAFE,
      hash: HASH,
      input: '0x1234',
      to: TARGET,
      value: 0n,
    },
    ...overrides,
  };
}

test('preview result binds ordered calls to the exact run profile', () => {
  assert.deepEqual(
    createPreviewResult({
      calls: [captured()],
      commit: COMMIT,
      deployerAddress: DEPLOYER,
      deployerStartingNonce: '15',
      previousDeployCid: CID,
      safeAddress: SAFE,
    }),
    {
      schemaVersion: 2,
      type: 'reya-cannon-read-only-preview',
      commit: COMMIT,
      cannon: {
        stateFormatVersion: 7,
        version: '2.26.1',
      },
      chainId: 1729,
      safeAddress: SAFE,
      deployerAddress: DEPLOYER,
      deployerStartingNonce: '15',
      previousDeployCid: CID,
      deployerPrerequisites: [],
      safeProposalCalls: [
        {
          data: '0x1234',
          from: SAFE,
          gasUsed: '100',
          sequence: 0,
          senderRole: 'safe',
          step: 'invoke.upgrade',
          to: TARGET,
          transactionHash: HASH,
          value: '0',
        },
      ],
      simulationTransactions: [
        {
          data: '0x1234',
          from: SAFE,
          gasUsed: '100',
          sequence: 0,
          senderRole: 'safe',
          step: 'invoke.upgrade',
          to: TARGET,
          transactionHash: HASH,
          value: '0',
        },
      ],
    }
  );
});

test('preview result rejects creations, unknown senders, empty and duplicate captures', () => {
  assert.throws(
    () =>
      createPreviewResult({
        calls: [],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        previousDeployCid: CID,
        safeAddress: SAFE,
      }),
    /framing is invalid/
  );
  assert.throws(
    () =>
      createPreviewResult({
        calls: [captured({ transaction: { ...captured().transaction, to: null } })],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        previousDeployCid: CID,
        safeAddress: SAFE,
      }),
    /approved signer contract/
  );
  assert.throws(
    () =>
      createPreviewResult({
        calls: [
          captured({
            transaction: {
              ...captured().transaction,
              from: TARGET,
            },
          }),
        ],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        previousDeployCid: CID,
        safeAddress: SAFE,
      }),
    /approved signer contract/
  );
  assert.throws(
    () =>
      createPreviewResult({
        calls: [captured(), captured()],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        previousDeployCid: CID,
        safeAddress: SAFE,
      }),
    /duplicate transaction/
  );
});

test('preview result separates deployer prerequisites from Safe proposal calls', () => {
  const creation = captured({
    receipt: {
      ...captured().receipt,
      from: DEPLOYER,
      to: null,
    },
    transaction: {
      ...captured().transaction,
      from: DEPLOYER,
      to: null,
    },
  });
  const result = createPreviewResult({
    calls: [
      creation,
      captured({
        hash: `0x${'34'.repeat(32)}`,
        receipt: {
          ...captured().receipt,
          transactionHash: `0x${'34'.repeat(32)}`,
        },
        transaction: {
          ...captured().transaction,
          hash: `0x${'34'.repeat(32)}`,
        },
      }),
    ],
    commit: COMMIT,
    deployerAddress: DEPLOYER,
    deployerStartingNonce: '15',
    previousDeployCid: CID,
    safeAddress: SAFE,
  });
  assert.equal(result.deployerPrerequisites.length, 1);
  assert.equal(result.deployerPrerequisites[0].senderRole, 'deployer');
  assert.equal(result.deployerPrerequisites[0].to, null);
  assert.equal(result.safeProposalCalls.length, 1);
  assert.equal(result.safeProposalCalls[0].senderRole, 'safe');
  assert.deepEqual(
    result.simulationTransactions.map(({ sequence }) => sequence),
    [0, 1]
  );
});

test('preview result rejects a deployer-only simulation as non-proposable', () => {
  const creation = captured({
    receipt: {
      ...captured().receipt,
      from: DEPLOYER,
      to: null,
    },
    transaction: {
      ...captured().transaction,
      from: DEPLOYER,
      to: null,
    },
  });
  assert.throws(
    () =>
      createPreviewResult({
        calls: [creation],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        previousDeployCid: CID,
        safeAddress: SAFE,
      }),
    /no Safe proposal calls/
  );
});

test('capture transport preserves request order when sends resolve in reverse', async () => {
  const capturedCalls = [];
  const resolvers = [];
  let step = 'deploy.first';
  const request = createOrderedRpcRequest({
    captured: capturedCalls,
    currentStep: () => step,
    rpc: {
      request() {
        return new Promise((resolve) => resolvers.push(resolve));
      },
    },
  });

  const first = request({ method: 'eth_sendTransaction', params: [{}] });
  step = 'invoke.second';
  const second = request({ method: 'eth_sendTransaction', params: [{}] });
  resolvers[1](`0x${'34'.repeat(32)}`);
  resolvers[0](HASH);
  await Promise.all([first, second]);

  assert.deepEqual(capturedCalls, [
    { hash: HASH, step: 'deploy.first' },
    { hash: `0x${'34'.repeat(32)}`, step: 'invoke.second' },
  ]);
});
