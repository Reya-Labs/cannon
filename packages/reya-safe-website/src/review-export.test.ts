import { describe, expect, it } from 'vitest';
import { createReviewExport } from './review-export';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH = `0x${'a'.repeat(64)}` as const;

function fixture() {
  return {
    deployment: {
      cannonfileUrl: null,
      cid: CID,
      descriptor: {
        cannonfileUrl:
          `https://github.com/Reya-Labs/reya-deployments/blob/${COMMIT}/` + 'packages/tomls/src/omnibus/reya_network.toml',
        cid: CID,
        packageRef: 'reya-omnibus:1.2.4@main',
        sourceCommit: COMMIT,
        status: 'partial' as const,
        version: '1.2.4',
      },
      inputKind: 'cid' as const,
      sourceCommit: COMMIT,
    },
    preview: {
      commit: COMMIT,
      deployerPrerequisiteCount: 0,
      partialDeployCid: CID,
      previousPackageCid: CID,
      safeAddress: SAFE,
      safeProposalCalls: [
        {
          data: '0x3659cfe60000000000000000000000002222222222222222222222222222222222222222' as const,
          decoded: {
            arguments: ['0x2222222222222222222222222222222222222222'],
            function: 'upgradeTo(address)',
            selector: '0x3659cfe6' as const,
          },
          from: SAFE,
          gasUsed: '42',
          senderRole: 'safe' as const,
          sequence: 0,
          step: 'invoke.upgrade',
          to: '0x2222222222222222222222222222222222222222' as const,
          transactionHash: `0x${'b'.repeat(64)}` as `0x${string}`,
          value: '0',
        },
      ],
      sourceBundleSha256: 'c'.repeat(64),
    },
    previous: {
      cid: CID,
      descriptor: {
        cannonfileUrl: null,
        cid: CID,
        packageRef: 'reya-omnibus:1.2.3@main',
        sourceCommit: null,
        status: 'complete' as const,
        version: '1.2.3',
      },
      inputKind: 'op-registry' as const,
    },
    safeTxHash: HASH,
    transaction: {
      _nonce: 7,
      baseGas: '0',
      data: '0x1234' as const,
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      operation: '1' as const,
      refundReceiver: SAFE,
      safeTxGas: '42',
      to: '0x3333333333333333333333333333333333333333' as `0x${string}`,
      value: '0',
    },
  };
}

describe('review snapshot export', () => {
  it('is deterministic, shareable and excludes wallet signatures', () => {
    const first = createReviewExport(fixture());
    const second = createReviewExport(fixture());

    expect(second.json).toBe(first.json);
    expect(first.filename).toBe('reya-cannon-safe-1729-7-aaaaaaaaaaaa.json');
    expect(first.value).toMatchObject({
      authorization: 'review-only',
      chainId: 1729,
      safe: {
        address: SAFE,
        nonce: 7,
        transactionHash: HASH,
      },
      schemaVersion: 2,
      type: 'reya-cannon-safe-review',
    });
    expect(first.json).toContain('"partialDeploymentCid"');
    expect(first.json).toContain('"orderedCalls"');
    expect(first.json).toContain('"decodedCalldata"');
    expect(first.json).not.toContain('"signature"');
    expect(first.json).not.toContain('"wallet"');
  });

  it('rejects a transaction envelope that is not bound to the preview Safe', () => {
    const input = fixture();
    expect(() =>
      createReviewExport({
        ...input,
        transaction: {
          ...input.transaction,
          refundReceiver: '0x2222222222222222222222222222222222222222',
        },
      })
    ).toThrow('REVIEW_EXPORT_REJECTED');
  });
});
