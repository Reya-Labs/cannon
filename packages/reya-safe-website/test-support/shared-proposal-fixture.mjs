import { encodeFunctionData } from 'viem';

export const E2E_SAFE = '0x1111111111111111111111111111111111111111';
export const E2E_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export function createSharedProposalPreviewFixture({
  bundleSha256,
  previousPackageCid,
}) {
  const target = '0x3333333333333333333333333333333333333333';
  const callData = encodeFunctionData({
    abi: [
      {
        inputs: [{ name: 'implementation', type: 'address' }],
        name: 'upgradeTo',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ],
    args: [target],
    functionName: 'upgradeTo',
  });
  const call = {
    data: callData,
    decoded: {
      arguments: [target],
      function: 'upgradeTo(address)',
      selector: callData.slice(0, 10),
    },
    from: E2E_SAFE,
    gasUsed: '100000',
    sequence: 0,
    senderRole: 'safe',
    step: 'invoke.upgrade_router',
    to: target,
    transactionHash: `0x${'88'.repeat(32)}`,
    value: '0',
  };
  return {
    cannon: { stateFormatVersion: 7, version: '2.26.1' },
    chainId: 1729,
    commit: E2E_COMMIT,
    deployerAddress: '0x2222222222222222222222222222222222222222',
    deployerPrerequisites: [],
    deployerStartingNonce: '9',
    partialDeployCid: null,
    previousPackageCid,
    qaEvidence: {
      artifactCount: 1,
      artifactInventorySha256: '99'.repeat(32),
      bundleSha256,
      cannonSource: {},
      forkBlock: {
        blockHash: `0x${'aa'.repeat(32)}`,
        blockNumber: '123',
        mode: 'upstream-finalized',
      },
      manifestSha256: 'bb'.repeat(32),
      mode: 'interactive-current-state',
    },
    safeAddress: E2E_SAFE,
    safeProposalCalls: [call],
    schemaVersion: 4,
    simulationTransactions: [call],
    type: 'reya-cannon-read-only-preview',
  };
}
