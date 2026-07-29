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

type FixtureCall = {
  data: string;
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
  previousDeployCid: string;
  qaEvidence: Record<string, unknown>;
  safeAddress: string;
  safeProposalCalls: FixtureCall[];
  schemaVersion: number;
  simulationTransactions: FixtureCall[];
  type: string;
} {
  const safeCall: FixtureCall = {
    data: '0x1234',
    from: SAFE,
    gasUsed: '100',
    senderRole: 'safe',
    sequence: 0,
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
    previousDeployCid: CID,
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
    schemaVersion: 2,
    simulationTransactions: [safeCall],
    type: 'reya-cannon-read-only-preview',
  };
}

describe('Reya website preview admission', () => {
  it('binds exact preview evidence to one stageable current-nonce transaction', () => {
    const parsed = parseReyaPreview(JSON.stringify(preview()), {
      commit: COMMIT,
      safeAddress: SAFE,
    });
    const txn = makeStageableSafeTransaction(parsed, 9);

    expect(parsed.sourceBundleSha256).toBe(BUNDLE);
    expect(parsed.safeProposalCalls).toHaveLength(1);
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
        safeAddress: SAFE,
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
        safeAddress: SAFE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('binds a selected previous-package CID when supplied', () => {
    expect(() =>
      parseReyaPreview(JSON.stringify(preview()), {
        commit: COMMIT,
        previousDeployCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        safeAddress: SAFE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('admits the automatic current-state review mode but rejects other modes', () => {
    const automatic = preview();
    automatic.qaEvidence.mode = 'interactive-current-state';
    expect(
      parseReyaPreview(JSON.stringify(automatic), {
        commit: COMMIT,
        safeAddress: SAFE,
      }).safeProposalCalls
    ).toHaveLength(1);

    automatic.qaEvidence.mode = 'production-authorized';
    expect(() =>
      parseReyaPreview(JSON.stringify(automatic), {
        commit: COMMIT,
        safeAddress: SAFE,
      })
    ).toThrow('PREVIEW_REJECTED');
  });

  it('keeps deployer prerequisites visible and non-stageable', () => {
    const candidate = preview();
    const prerequisite: FixtureCall = {
      data: '0x',
      from: DEPLOYER,
      gasUsed: '50',
      senderRole: 'deployer',
      sequence: 0,
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
      safeAddress: SAFE,
    });

    expect(parsed.deployerPrerequisiteCount).toBe(1);
    expect(() => makeStageableSafeTransaction(parsed, 9)).toThrow('PREVIEW_NOT_STAGEABLE');
  });
});
