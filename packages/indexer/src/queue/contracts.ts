import { createJobs } from '../helpers/create-queue';

/**
 * Runtime version of the Redis queue payload shared by the registry producer
 * and artifact worker. Jobs written before this field was introduced are
 * treated as V1 so an activation does not strand the existing BullMQ backlog.
 */
export const PINNING_JOB_CONTRACT_VERSION = 1 as const;

export type PinningJobName = 'PIN_CID' | 'PIN_PACKAGE';

export interface PinningJobData {
  cid: string;
  contractVersion?: number;
}

export interface ValidatedPinningJobData {
  cid: string;
  contractVersion: typeof PINNING_JOB_CONTRACT_VERSION;
}

/**
 * Matches the existing builder `extractValidCid` wire behavior without making
 * the producer contract depend on generated builder output.
 */
function extractLegacyCannonCid(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Invalid CID ${value}`);

  const trimmed = value.trim();
  const cid = trimmed.startsWith('ipfs://') ? trimmed.slice('ipfs://'.length) : trimmed;
  if (cid.length !== 46 || ![...cid].every((character) => /[a-zA-Z0-9]/.test(character))) {
    throw new Error(`Invalid CID ${value}`);
  }

  return cid;
}

export function validatePinningJobData(data: PinningJobData): ValidatedPinningJobData {
  const contractVersion = data.contractVersion ?? PINNING_JOB_CONTRACT_VERSION;
  if (contractVersion !== PINNING_JOB_CONTRACT_VERSION) {
    throw new Error(`Unsupported pinning job contract version: ${contractVersion}`);
  }

  return {
    cid: extractLegacyCannonCid(data.cid),
    contractVersion: PINNING_JOB_CONTRACT_VERSION,
  };
}

function createJob(name: PinningJobName, data: PinningJobData) {
  const validated = validatePinningJobData(data);
  return {
    name,
    data: validated,
    opts: { jobId: `${name}_${validated.cid}` },
  };
}

/**
 * Producer-only job definitions. This module intentionally has no object-store
 * or artifact-handler imports.
 */
export const pinningJobContracts = createJobs(
  [
    {
      name: 'PIN_CID',
      action(data: PinningJobData) {
        return createJob('PIN_CID', data);
      },
    },
    {
      name: 'PIN_PACKAGE',
      action(data: PinningJobData) {
        return createJob('PIN_PACKAGE', data);
      },
    },
  ],
  {}
);
