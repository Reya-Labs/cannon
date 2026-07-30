import { prepareReyaSafeTransaction } from '@reya/cannon-safe-ui/safe-review';
import type { ReyaSafeTransaction } from '@reya/cannon-safe-ui/clients';
import { recoverAddress } from 'viem';

const TRANSACTION_FIELDS = [
  '_nonce',
  'baseGas',
  'data',
  'gasPrice',
  'gasToken',
  'operation',
  'refundReceiver',
  'safeTxGas',
  'to',
  'value',
] as const;

export type SharedProposal = Readonly<{
  createdAt: number;
  sigs: readonly `0x${string}`[];
  txn: ReyaSafeTransaction;
  updatedAt: number;
}>;

export type SharedProposalStatus = Readonly<{
  createdAt: number;
  safeTxHash: `0x${string}`;
  signedOwners: readonly `0x${string}`[];
  threshold: number;
  thresholdReached: boolean;
  txn: ReyaSafeTransaction;
  unsignedOwners: readonly `0x${string}`[];
  updatedAt: number;
}>;

type SafeState = Readonly<{
  nonce: number;
  owners: readonly `0x${string}`[];
  threshold: number;
}>;

function rejectProposal(): never {
  throw new Error('SHARED_PROPOSAL_REJECTED');
}

/**
 * Re-authenticates a staged proposal against the current Safe owner set.
 *
 * The staging service already filters invalid signatures. Repeating recovery in
 * the browser prevents a compromised response from inventing signer or
 * threshold status in the review surface.
 */
export async function inspectSharedProposal(input: {
  proposal: SharedProposal;
  safeAddress: `0x${string}`;
  safeState: SafeState;
}): Promise<SharedProposalStatus> {
  if (input.proposal.txn._nonce !== input.safeState.nonce) rejectProposal();

  const prepared = prepareReyaSafeTransaction({
    safeAddress: input.safeAddress,
    txn: input.proposal.txn,
  });
  const currentOwners = new Set(input.safeState.owners);
  const recoveredOwners = new Set<`0x${string}`>();

  for (const signature of input.proposal.sigs) {
    let owner: `0x${string}`;
    try {
      owner = (
        await recoverAddress({
          hash: prepared.safeTxHash,
          signature,
        })
      ).toLowerCase() as `0x${string}`;
    } catch {
      rejectProposal();
    }
    if (!currentOwners.has(owner) || recoveredOwners.has(owner)) {
      rejectProposal();
    }
    recoveredOwners.add(owner);
  }

  const signedOwners = Object.freeze(input.safeState.owners.filter((owner) => recoveredOwners.has(owner)));
  const unsignedOwners = Object.freeze(input.safeState.owners.filter((owner) => !recoveredOwners.has(owner)));

  return Object.freeze({
    createdAt: input.proposal.createdAt,
    safeTxHash: prepared.safeTxHash,
    signedOwners,
    threshold: input.safeState.threshold,
    thresholdReached: signedOwners.length >= input.safeState.threshold,
    txn: input.proposal.txn,
    unsignedOwners,
    updatedAt: input.proposal.updatedAt,
  });
}

export function sharedProposalMatchesReview(
  proposal: SharedProposalStatus,
  transaction: ReyaSafeTransaction,
  safeTxHash: `0x${string}`
): boolean {
  return (
    proposal.safeTxHash === safeTxHash && TRANSACTION_FIELDS.every((field) => proposal.txn[field] === transaction[field])
  );
}
