import { createHash } from 'node:crypto';
import { HttpError } from './errors';
import type { Admission, AdmissionInput, ProposalAdmissionVerifier } from './types';

export class PilotAdmissionVerifier implements ProposalAdmissionVerifier {
  constructor(private readonly enabled: boolean) {}

  async verify(input: AdmissionInput): Promise<Admission> {
    if (!this.enabled) {
      throw new HttpError(
        503,
        'production_admission_unconfigured',
        'production proposal admission is disabled until the CI attestation verifier is configured'
      );
    }
    if (input.attestation) {
      throw new HttpError(400, 'pilot_attestation_unsupported', 'pilot mode does not accept an unverified attestation');
    }

    return {
      id: createHash('sha256')
        .update(`pilot:${input.chainId}:${input.safeAddress.toLowerCase()}:${input.safeTxHash}`)
        .digest('hex'),
    };
  }
}
