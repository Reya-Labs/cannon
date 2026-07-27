import { createJobs } from '../helpers/create-queue';
import { createHash } from 'node:crypto';

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
  metadataCids?: string[];
}

export interface ValidatedPinningJobData {
  cid: string;
  contractVersion: typeof PINNING_JOB_CONTRACT_VERSION;
  metadataCids?: string[];
}

const MAX_METADATA_CIDS = 32;

/**
 * Matches the existing builder `extractValidCid` wire behavior without making
 * the producer contract depend on generated builder output.
 */
export function normalizePinningCid(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid CID');

  const trimmed = value.trim();
  const cid = trimmed.startsWith('ipfs://') ? trimmed.slice('ipfs://'.length) : trimmed;
  if (cid.length !== 46 || ![...cid].every((character) => /[a-zA-Z0-9]/.test(character))) {
    throw new Error('Invalid CID');
  }

  return cid;
}

/**
 * Applies the queue wire-format CID rules without reflecting malformed input.
 */
export function tryNormalizePinningCid(value: unknown): string | undefined {
  try {
    return normalizePinningCid(value);
  } catch {
    return undefined;
  }
}

/**
 * Converts one optional on-chain metadata URL into queue-safe CID metadata.
 * Invalid optional metadata is omitted so it cannot suppress the deployment
 * artifact job.
 */
export function optionalPinningMetadataCids(value: unknown): string[] | undefined {
  const cid = tryNormalizePinningCid(value);
  return cid ? [cid] : undefined;
}

export function validatePinningJobData(data: PinningJobData): ValidatedPinningJobData {
  if (!data || typeof data !== 'object') throw new Error('Invalid pinning job data');

  const contractVersion = data.contractVersion ?? PINNING_JOB_CONTRACT_VERSION;
  if (contractVersion !== PINNING_JOB_CONTRACT_VERSION) {
    throw new Error('Unsupported pinning job contract version');
  }

  if (data.metadataCids !== undefined && !Array.isArray(data.metadataCids)) {
    throw new Error('metadataCids must be an array');
  }
  if ((data.metadataCids?.length ?? 0) > MAX_METADATA_CIDS) {
    throw new Error(`metadataCids exceeds the ${MAX_METADATA_CIDS} item limit`);
  }

  const metadataCids = data.metadataCids ? [...new Set(data.metadataCids.map(normalizePinningCid))].sort() : undefined;

  return {
    cid: normalizePinningCid(data.cid),
    contractVersion: PINNING_JOB_CONTRACT_VERSION,
    ...(metadataCids?.length ? { metadataCids } : {}),
  };
}

function createJob(name: PinningJobName, data: PinningJobData) {
  const validated = validatePinningJobData(data);
  if (name === 'PIN_CID' && validated.metadataCids) {
    throw new Error('PIN_CID does not accept metadataCids');
  }

  const metadataSuffix =
    name === 'PIN_PACKAGE' && validated.metadataCids
      ? `_metadata_${createHash('sha256').update(validated.metadataCids.join('\n')).digest('hex').slice(0, 16)}`
      : '';

  return {
    name,
    data: validated,
    opts: { jobId: `${name}_${validated.cid}${metadataSuffix}` },
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
