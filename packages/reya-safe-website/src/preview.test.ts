import { describe, expect, it } from 'vitest';
import { prepareReyaSafeTransaction } from '@reya/cannon-safe-ui/safe-review';
import { makeStageableSafeTransaction, parseReyaPreview } from './preview';

const SAFE = '0x1111111111111111111111111111111111111111';
const DEPLOYER = '0x2222222222222222222222222222222222222222';
const TARGET = '0x3333333333333333333333333333333333333333';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const HASH = `0x${'12'.repeat(32)}`;
const BUNDLE = '34'.repeat(32);
const CALLDATA = '0x3659cfe60000000000000000000000003333333333333333333333333333333333333333';

type FixtureCall = {
  data: string;
  decoded: {
    arguments: unknown[];
    function: string;
    selector: string;
  } | null;
  from: string;
  gasUsed: string;
  senderRole: 'deployer' | 'safe';
  sequence: number;
  step: string;
  to: string | null;
  transactionHash: string;
  value: string;
};

function preview(): {
  cannon: { stateFormatVersion: number; version: string };
  chainId: number;
  commit: string;
  deployerAddress: string;
  deployerPrerequisites: FixtureCall[];
  deployerStartingNonce: string;
  partialDeployCid: string | null;
  previousPackageCid: string;
  qaEvidence: Record<string, unknown>;
  safeAddress: string;
  safeProposalCalls: FixtureCall[];
  schemaVersion: number;
  simulationTransactions: FixtureCall[];
  type: string;
} {
  const safeCall: FixtureCall = {
    data: CALLDATA,
    decoded: {
      arguments: [TARGET],
      function: 'upgradeTo(address)',
      selector: '0x3659cfe6',
    },
    from: SAFE,
    gasUsed: '100',
    sequence: 0,
    senderRole: 'safe',
    step: 'invoke.upgrade',
    to: TARGET,
    transactionHash: HASH,
    value: '0',
  };
  return {
    cannon: { stateFormatVersion: 7, version: '2.26.1' },
    chainId: 1729,
    commit: COMMIT,
    deployerAddress: DEPLOYER,
    deployerPrerequisites: [],
    deployerStartingNonce: '7',
    partialDeployCid: null,
    previousPackageCid: CID,
    qaEvidence: {
      artifactCount: 1,
      artifactInventorySha256: '56'.repeat(32),
      bundleSha256: BUNDLE,
      cannonSource: {},
      forkBlock: {
        blockHash: `0x${'78'.repeat(32)}`,
        blockNumber: '123',
        mode: 'upstream-finalized',
      },
      manifestSha256: '90'.repeat(32),
      mode: 'non-signable-local-qa',
    },
    safeAddress: SAFE,
    safeProposalCalls: [safeCall],
    schemaVersion: 4,
    simulationTransactions: [safeCall],
    type: 'reya-cannon-read-only-preview',
  };
}

describe('Reya website preview admission', () => {
  it('binds exact preview evidence to one stageable current-nonce transaction', () => {
    const parsed = parseReyaPreview(JSON.stringify(preview()), {
      commit: COMMIT,
      partialDeployCid: null,
      previousPackageCid: CID,
      safeAddress: SAFE,
      sourceBundleSha256: BUNDLE,
    });
    const txn = makeStageableSafeTransaction(parsed, 9);

    expect(parsed.sourceBundleSha256).toBe(BUNDLE);
    expect(parsed.safeProposalCalls).toHaveLength(1);
    expect(parsed.safeProposalCalls[0].decoded).toEqual({
      arguments: [TARGET],
      function: 'upgradeTo(address)',
      selector: '0x3659cfe6',
    });
    expect(txn._nonce).toBe(9);
    expect(txn.operation).toBe('1');
    expect(txn.safeTxGas).toBe('100');
    expect(txn.refundReceiver).toBe(SAFE);
    expect(
      prepareReyaSafeTransaction({
        safeAddress: SAFE,
        txn,
      }).safeTxHash
    ).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it.each([
    ['chainId', 1],
    ['commit', 'fedcba9876543210fedcba9876543210fedcba98'],
    ['safeAddress', DEPLOYER],
    ['type', 'stageable'],
  ])('rejects a changed %s', (key, value) => {
    const candidate = { ...preview(), [key]: value };
    expect(() =>
      parseReyaPreview(JSON.stringify(candidate), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('rejects a safe-call list that diverges from simulation evidence', () => {
    const candidate = preview();
    candidate.safeProposalCalls[0] = {
      ...candidate.safeProposalCalls[0],
      data: '0xabcd',
    };
    expect(() =>
      parseReyaPreview(JSON.stringify(candidate), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('rejects decoded calldata that is not bound to the raw selector', () => {
    const candidate = preview();
    candidate.safeProposalCalls[0].decoded = {
      arguments: [TARGET],
      function: 'transfer(address,uint256)',
      selector: '0xa9059cbb',
    };
    candidate.simulationTransactions = candidate.safeProposalCalls;
    expect(() =>
      parseReyaPreview(JSON.stringify(candidate), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('binds selected partial and previous-package CIDs plus the source digest', () => {
    expect(() =>
      parseReyaPreview(JSON.stringify(preview()), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
    expect(() =>
      parseReyaPreview(JSON.stringify(preview()), {
        commit: COMMIT,
        partialDeployCid: CID,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
    expect(() =>
      parseReyaPreview(JSON.stringify(preview()), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: 'ff'.repeat(32),
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('admits the automatic current-state review mode but rejects other modes', () => {
    const automatic = preview();
    automatic.qaEvidence.mode = 'interactive-current-state';
    expect(
      parseReyaPreview(JSON.stringify(automatic), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      }).safeProposalCalls
    ).toHaveLength(1);

    automatic.qaEvidence.mode = 'production-authorized';
    expect(() =>
      parseReyaPreview(JSON.stringify(automatic), {
        commit: COMMIT,
        partialDeployCid: null,
        previousPackageCid: CID,
        safeAddress: SAFE,
        sourceBundleSha256: BUNDLE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('keeps deployer prerequisites visible and non-stageable', () => {
    const candidate = preview();
    const prerequisite: FixtureCall = {
      data: '0x',
      decoded: null,
      from: DEPLOYER,
      gasUsed: '50',
      sequence: 0,
      senderRole: 'deployer',
      step: 'deploy.create',
      to: null,
      transactionHash: `0x${'ab'.repeat(32)}`,
      value: '0',
    };
    const safeCall = {
      ...candidate.safeProposalCalls[0],
      sequence: 1,
    };
    candidate.deployerPrerequisites = [prerequisite];
    candidate.safeProposalCalls = [safeCall];
    candidate.simulationTransactions = [prerequisite, safeCall];
    const parsed = parseReyaPreview(JSON.stringify(candidate), {
      commit: COMMIT,
      partialDeployCid: null,
      previousPackageCid: CID,
      safeAddress: SAFE,
      sourceBundleSha256: BUNDLE,
    });

    expect(parsed.deployerPrerequisiteCount).toBe(1);
    expect(() => makeStageableSafeTransaction(parsed, 9)).toThrow('PREVIEW_NOT_STAGEABLE');
  });
});
