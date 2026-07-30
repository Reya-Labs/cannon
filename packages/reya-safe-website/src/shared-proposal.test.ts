import { prepareReyaSafeTransaction } from '@reya/cannon-safe-ui/safe-review';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { inspectSharedProposal, sharedProposalMatchesReview } from './shared-proposal';

const SAFE = '0x1111111111111111111111111111111111111111' as const;
const OWNER = privateKeyToAccount('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
const OTHER_OWNER = privateKeyToAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd');
const NON_OWNER = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const TRANSACTION = {
  _nonce: 7,
  baseGas: '0',
  data: '0x1234',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  operation: '1',
  refundReceiver: '0x0000000000000000000000000000000000000000',
  safeTxGas: '42',
  to: '0x2222222222222222222222222222222222222222',
  value: '0',
} as const;

async function signature(account: typeof OWNER) {
  const { safeTxHash } = prepareReyaSafeTransaction({
    safeAddress: SAFE,
    txn: TRANSACTION,
  });
  return account.sign({ hash: safeTxHash });
}

describe('shared Safe proposal inspection', () => {
  it('recovers current owners and reports threshold progress', async () => {
    const inspected = await inspectSharedProposal({
      proposal: {
        createdAt: 1,
        sigs: [await signature(OWNER)],
        txn: TRANSACTION,
        updatedAt: 2,
      },
      safeAddress: SAFE,
      safeState: {
        nonce: 7,
        owners: [OWNER.address.toLowerCase() as `0x${string}`, OTHER_OWNER.address.toLowerCase() as `0x${string}`],
        threshold: 2,
      },
    });

    expect(inspected.signedOwners).toEqual([OWNER.address.toLowerCase()]);
    expect(inspected.unsignedOwners).toEqual([OTHER_OWNER.address.toLowerCase()]);
    expect(inspected.thresholdReached).toBe(false);
    expect(sharedProposalMatchesReview(inspected, TRANSACTION, inspected.safeTxHash)).toBe(true);
    expect(sharedProposalMatchesReview(inspected, { ...TRANSACTION, safeTxGas: '43' }, inspected.safeTxHash)).toBe(false);
  });

  it('rejects stale, duplicate and non-owner signer status', async () => {
    const ownerSignature = await signature(OWNER);
    const proposal = {
      createdAt: 1,
      sigs: [ownerSignature],
      txn: TRANSACTION,
      updatedAt: 2,
    } as const;
    const safeState = {
      nonce: 7,
      owners: [OWNER.address.toLowerCase() as `0x${string}`],
      threshold: 1,
    } as const;

    await expect(
      inspectSharedProposal({
        proposal,
        safeAddress: SAFE,
        safeState: { ...safeState, nonce: 8 },
      })
    ).rejects.toThrow('SHARED_PROPOSAL_REJECTED');
    await expect(
      inspectSharedProposal({
        proposal: { ...proposal, sigs: [ownerSignature, ownerSignature] },
        safeAddress: SAFE,
        safeState,
      })
    ).rejects.toThrow('SHARED_PROPOSAL_REJECTED');
    await expect(
      inspectSharedProposal({
        proposal: { ...proposal, sigs: [await signature(NON_OWNER)] },
        safeAddress: SAFE,
        safeState,
      })
    ).rejects.toThrow('SHARED_PROPOSAL_REJECTED');
  });
});
