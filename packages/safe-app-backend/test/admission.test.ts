import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { createAdmissionVerifier, SafeOwnerAdmissionVerifier } from '../src/admission';
import type { AdmissionInput, SafeTransaction } from '../src/types';

const SAFE = getAddress('0x1111111111111111111111111111111111111111');
const OWNER = getAddress('0x2222222222222222222222222222222222222222');
const SAFE_TX_HASH = `0x${'ab'.repeat(32)}` as Hex;
const SIGNATURE = `0x${'cd'.repeat(65)}` as Hex;
const TRANSACTION: SafeTransaction = {
  _nonce: 7,
  baseGas: '0',
  data: '0x',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  operation: '0',
  refundReceiver: SAFE,
  safeTxGas: '0',
  to: OWNER,
  value: '0',
};

function input(overrides: Partial<AdmissionInput> = {}): AdmissionInput {
  return {
    actor: { roles: new Set<'proposer'>(['proposer']), subject: 'proposer@example.com' },
    chainId: 1729,
    safeAddress: SAFE,
    safeTxHash: SAFE_TX_HASH,
    txn: TRANSACTION,
    verifiedSignatures: [{ owner: OWNER, signature: SIGNATURE }],
    ...overrides,
  };
}

describe('safe-owner admission', () => {
  it('is selected explicitly and binds a deterministic ID to the reviewed Safe transaction', async () => {
    const verifier = createAdmissionVerifier('safe-owner');
    const first = await verifier.verify(input());
    const second = await verifier.verify(
      input({
        actor: { roles: new Set<'signer'>(['signer']), subject: 'another-owner@example.com' },
      })
    );

    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(second.id).toBe(first.id);
    await expect(verifier.verify(input({ safeTxHash: `0x${'ef'.repeat(32)}` }))).resolves.not.toEqual(first);
  });

  it('fails closed without a verified current-owner signature or when an attestation is supplied', async () => {
    const verifier = new SafeOwnerAdmissionVerifier();

    await expect(verifier.verify(input({ verifiedSignatures: [] }))).rejects.toMatchObject({
      code: 'safe_owner_signature_required',
      status: 400,
    });
    await expect(
      verifier.verify({
        ...input(),
        attestation: { format: 'test', payload: 'unverified', signature: 'unverified' },
      })
    ).rejects.toMatchObject({
      code: 'safe_owner_attestation_unsupported',
      status: 400,
    });
  });
});
