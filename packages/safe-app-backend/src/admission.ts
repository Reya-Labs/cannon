import { createHash } from 'node:crypto';
import type { AdmissionMode } from './config';
import { HttpError } from './errors';
import type { Admission, AdmissionInput, ProposalAdmissionVerifier } from './types';

/**
 * Admits a proposal only after the Safe validator has authenticated at least
 * one current-owner signature over the exact Safe transaction hash.
 */
export class SafeOwnerAdmissionVerifier implements ProposalAdmissionVerifier {
  async verify(input: AdmissionInput): Promise<Admission> {
    if (input.verifiedSignatures.length === 0) {
      throw new HttpError(
        400,
        'safe_owner_signature_required',
        'safe-owner admission requires at least one verified current-owner signature'
      );
    }
    if (input.attestation) {
      throw new HttpError(
        400,
        'safe_owner_attestation_unsupported',
        'safe-owner admission does not accept an unverified attestation'
      );
    }

    return {
      id: createHash('sha256')
        .update(`safe-owner:v1:${input.chainId}:${input.safeAddress.toLowerCase()}:${input.safeTxHash}`)
        .digest('hex'),
    };
  }
}

/** Constructs the verifier for the startup-validated admission mode. */
export function createAdmissionVerifier(mode: AdmissionMode): ProposalAdmissionVerifier {
  switch (mode) {
    case 'safe-owner':
      return new SafeOwnerAdmissionVerifier();
  }
}
