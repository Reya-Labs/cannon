import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInvokeDecoders,
  createOrderedRpcRequest,
  createPreviewResult,
  decodeCapturedCall,
} from '../src/runtime/preview-engine.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const DEPLOYER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH = `0x${'12'.repeat(32)}`;
const NEXT = '0x3333333333333333333333333333333333333333';
const CALLDATA =
  '0x3659cfe60000000000000000000000003333333333333333333333333333333333333333';
const DECODED = {
  arguments: [NEXT],
  function: 'upgradeTo(address)',
  selector: '0x3659cfe6',
};
const UPGRADE_ABI = [
  {
    inputs: [{ name: 'newImplementation', type: 'address' }],
    name: 'upgradeTo',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

function captured(overrides = {}) {
  return {
    decoded: DECODED,
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
      input: CALLDATA,
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
      partialDeployCid: null,
      previousPackageCid: CID,
      safeAddress: SAFE,
    }),
    {
      schemaVersion: 4,
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
      partialDeployCid: null,
      previousPackageCid: CID,
      deployerPrerequisites: [],
      safeProposalCalls: [
        {
          data: CALLDATA,
          decoded: DECODED,
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
          data: CALLDATA,
          decoded: DECODED,
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
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
      }),
    /framing is invalid/
  );
  assert.throws(
    () =>
      createPreviewResult({
        calls: [
          captured({ transaction: { ...captured().transaction, to: null } }),
        ],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        partialDeployCid: null,
        previousPackageCid: CID,
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
        partialDeployCid: null,
        previousPackageCid: CID,
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
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
      }),
    /duplicate transaction/
  );
});

test('decodes invoke calldata only through the target ABI and expected Cannon function', () => {
  assert.deepEqual(
    decodeCapturedCall({
      decoders: [
        {
          abi: UPGRADE_ABI,
          address: TARGET,
          expectedFunction: 'upgradeTo',
        },
      ],
      step: 'invoke.upgrade',
      transaction: {
        input: CALLDATA,
        to: TARGET,
      },
    }),
    DECODED
  );
  assert.throws(
    () =>
      decodeCapturedCall({
        decoders: [
          {
            abi: UPGRADE_ABI,
            address: TARGET,
            expectedFunction: 'transfer',
          },
        ],
        step: 'invoke.upgrade',
        transaction: {
          input: CALLDATA,
          to: TARGET,
        },
      }),
    /not uniquely decodable/
  );
});

test('resolves a checksummed address target through the Cannon custom ABI', () => {
  assert.deepEqual(
    createInvokeDecoders(
      {
        abi: JSON.stringify(UPGRADE_ABI),
        func: 'upgradeTo',
        target: ['0x27E5cb712334e101B3c232eB0Be198baaa595F5F'],
      },
      {}
    ),
    [
      {
        abi: UPGRADE_ABI,
        address: '0x27e5cb712334e101b3c232eb0be198baaa595f5f',
        expectedFunction: 'upgradeTo',
      },
    ]
  );
});

test('preview result separates deployer prerequisites from Safe proposal calls', () => {
  const creation = captured({
    decoded: null,
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
    step: 'deploy.create',
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
    partialDeployCid: null,
    previousPackageCid: CID,
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
    decoded: null,
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
    step: 'deploy.create',
  });
  assert.throws(
    () =>
      createPreviewResult({
        calls: [creation],
        commit: COMMIT,
        deployerAddress: DEPLOYER,
        deployerStartingNonce: '15',
        partialDeployCid: null,
        previousPackageCid: CID,
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
