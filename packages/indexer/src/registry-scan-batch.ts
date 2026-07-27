import { createHash } from 'node:crypto';
import { parseRegistryCheckpoint, RegistryCheckpointV1, serializeRegistryCheckpoint } from './registry-checkpoint';
import {
  parseRegistryEventEnvelope,
  RegistryEventEnvelopeV1,
  serializeRegistryEventEnvelope,
} from './registry-event-envelope';

export const REGISTRY_SCAN_BATCH_VERSION = 1 as const;

export const REGISTRY_SCAN_BATCH_MAX_EVENTS = 512;
export const REGISTRY_SCAN_BATCH_MAX_ENVELOPE_BYTES = 64 * 1024;
export const REGISTRY_SCAN_BATCH_MAX_SERIALIZED_BYTES = 1024 * 1024;
export const REGISTRY_SCAN_BATCH_MAX_URL_BYTES = 2048;
export const REGISTRY_SCAN_BATCH_MAX_PUBLISHERS = 256;
export const REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT = (1n << 64n) - 1n;

const MAX_UINT256 = (1n << 256n) - 1n;

export type RegistryScanBatchV1 = {
  version: typeof REGISTRY_SCAN_BATCH_VERSION;
  registryChainId: number;
  previousCheckpoint: RegistryCheckpointV1 | null;
  scanFromBlock: string;
  checkpoint: RegistryCheckpointV1;
  scanToTimestamp: string;
  events: RegistryEventEnvelopeV1[];
};

type UnknownRecord = Record<string, unknown>;

function invalid(label: string): never {
  throw new Error(`Invalid registry scan batch: ${label}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown): UnknownRecord {
  if (!isRecord(value)) invalid('value must be an object');
  return value;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactKeys(value: UnknownRecord): void {
  const expectedKeys = [
    'version',
    'registryChainId',
    'previousCheckpoint',
    'scanFromBlock',
    'checkpoint',
    'scanToTimestamp',
    'events',
  ];
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));

  if (missing.length > 0) invalid(`missing ${missing.join(', ')}`);
  if (unexpected.length > 0) invalid(`unexpected fields: ${unexpected.join(', ')}`);
}

function normalizeChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('registryChainId must be a positive safe integer');
  }
  return value;
}

function normalizeUint(value: unknown, label: string): string {
  let normalized: bigint;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    invalid(`${label} must be an unsigned integer`);
  }

  if (normalized < 0n || normalized > MAX_UINT256) invalid(`${label} must fit uint256`);
  return normalized.toString();
}

function expectCanonicalUint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid(`${label} must be a canonical unsigned integer string`);
  }
  return normalizeUint(value, label);
}

function normalizeCheckpoint(value: unknown, registryChainId: number, label: string): RegistryCheckpointV1 {
  if (!isRecord(value)) invalid(`${label} must be an object`);

  try {
    return parseRegistryCheckpoint(serializeRegistryCheckpoint(value as RegistryCheckpointV1), registryChainId);
  } catch {
    return invalid(`${label} is invalid`);
  }
}

function normalizePreviousCheckpoint(value: unknown, registryChainId: number): RegistryCheckpointV1 | null {
  return value === null ? null : normalizeCheckpoint(value, registryChainId, 'previousCheckpoint');
}

function normalizeEnvelope(value: unknown): RegistryEventEnvelopeV1 {
  if (!isRecord(value)) invalid('event must be an object');

  try {
    return parseRegistryEventEnvelope(serializeRegistryEventEnvelope(value as RegistryEventEnvelopeV1));
  } catch {
    return invalid('event is invalid');
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function enforceEventBounds(envelope: RegistryEventEnvelopeV1, serialized: string): void {
  if (byteLength(serialized) > REGISTRY_SCAN_BATCH_MAX_ENVELOPE_BYTES) {
    invalid(`event ${envelope.id} exceeds the serialized envelope limit`);
  }

  if (envelope.event.name === 'PackagePublish' || envelope.event.name === 'PackagePublishWithFee') {
    if (byteLength(envelope.event.deployUrl) > REGISTRY_SCAN_BATCH_MAX_URL_BYTES) {
      invalid('event.deployUrl exceeds the URL limit');
    }
    if (byteLength(envelope.event.metaUrl) > REGISTRY_SCAN_BATCH_MAX_URL_BYTES) {
      invalid('event.metaUrl exceeds the URL limit');
    }
  }

  if (
    envelope.event.name === 'PackagePublishersChanged' &&
    envelope.event.publishers.length > REGISTRY_SCAN_BATCH_MAX_PUBLISHERS
  ) {
    invalid('event.publishers exceeds the publisher-count limit');
  }
}

function compareLogPosition(left: RegistryEventEnvelopeV1, right: RegistryEventEnvelopeV1): number {
  const blockDelta = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (blockDelta < 0n) return -1;
  if (blockDelta > 0n) return 1;
  return left.logIndex - right.logIndex;
}

function normalizeBatch(value: unknown): RegistryScanBatchV1 {
  const batch = expectRecord(value);
  assertExactKeys(batch);

  if (batch.version !== REGISTRY_SCAN_BATCH_VERSION) {
    invalid(`unsupported version ${String(batch.version)}`);
  }

  const registryChainId = normalizeChainId(batch.registryChainId);
  const previousCheckpoint = normalizePreviousCheckpoint(batch.previousCheckpoint, registryChainId);
  const checkpoint = normalizeCheckpoint(batch.checkpoint, registryChainId, 'checkpoint');
  const scanFromBlock = expectCanonicalUint(batch.scanFromBlock, 'scanFromBlock');
  const scanToTimestamp = expectCanonicalUint(batch.scanToTimestamp, 'scanToTimestamp');
  if (!Array.isArray(batch.events)) invalid('events must be an array');
  if (batch.events.length > REGISTRY_SCAN_BATCH_MAX_EVENTS) {
    invalid(`events exceeds the ${REGISTRY_SCAN_BATCH_MAX_EVENTS} item limit`);
  }

  const scanFrom = BigInt(scanFromBlock);
  const scanTo = BigInt(checkpoint.blockNumber);
  if (scanFrom > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT || scanTo > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT) {
    invalid('scan block range exceeds the Redis stream ID limit');
  }
  if (scanTo < scanFrom) invalid('checkpoint precedes scanFromBlock');

  if (previousCheckpoint !== null) {
    const previousBlock = BigInt(previousCheckpoint.blockNumber);
    if (previousBlock === MAX_UINT256 || scanFrom !== previousBlock + 1n) {
      invalid('scanFromBlock must be the checkpoint successor');
    }
  }

  const events = batch.events.map(normalizeEnvelope);
  let previousEvent: RegistryEventEnvelopeV1 | undefined;
  const blockHashes = new Map<string, string>();
  for (const envelope of events) {
    if (envelope.registryChainId !== registryChainId) invalid('event registry chain mismatch');

    const eventBlock = BigInt(envelope.blockNumber);
    if (eventBlock < scanFrom || eventBlock > scanTo) invalid('event falls outside the scan block range');
    if (BigInt(envelope.timestamp) > BigInt(scanToTimestamp)) {
      invalid('event timestamp exceeds the scan checkpoint timestamp');
    }
    if (previousEvent && compareLogPosition(previousEvent, envelope) >= 0) {
      invalid('events must be strictly ordered by block number and log index');
    }
    const observedBlockHash = blockHashes.get(envelope.blockNumber);
    if (observedBlockHash !== undefined && observedBlockHash !== envelope.blockHash) {
      invalid('events from one block must share its block hash');
    }
    if (eventBlock === scanTo && envelope.blockHash !== checkpoint.blockHash) {
      invalid('terminal event block hash must match the checkpoint');
    }

    const serialized = serializeRegistryEventEnvelope(envelope);
    enforceEventBounds(envelope, serialized);
    blockHashes.set(envelope.blockNumber, envelope.blockHash);
    previousEvent = envelope;
  }

  const normalized: RegistryScanBatchV1 = {
    version: REGISTRY_SCAN_BATCH_VERSION,
    registryChainId,
    previousCheckpoint,
    scanFromBlock,
    checkpoint,
    scanToTimestamp,
    events,
  };

  if (byteLength(JSON.stringify(normalized)) > REGISTRY_SCAN_BATCH_MAX_SERIALIZED_BYTES) {
    invalid('serialized batch exceeds the batch limit');
  }

  return normalized;
}

export function createRegistryScanBatch(input: {
  registryChainId: number;
  previousCheckpoint: RegistryCheckpointV1 | null;
  scanFromBlock: bigint | number | string;
  checkpoint: RegistryCheckpointV1;
  scanToTimestamp: bigint | number | string;
  events: readonly RegistryEventEnvelopeV1[];
}): RegistryScanBatchV1 {
  return normalizeBatch({
    version: REGISTRY_SCAN_BATCH_VERSION,
    registryChainId: input.registryChainId,
    previousCheckpoint: input.previousCheckpoint,
    scanFromBlock: normalizeUint(input.scanFromBlock, 'scanFromBlock'),
    checkpoint: input.checkpoint,
    scanToTimestamp: normalizeUint(input.scanToTimestamp, 'scanToTimestamp'),
    events: [...input.events],
  });
}

export function serializeRegistryScanBatch(batch: RegistryScanBatchV1): string {
  return JSON.stringify(normalizeBatch(batch));
}

export function parseRegistryScanBatch(serialized: string): RegistryScanBatchV1 {
  if (typeof serialized !== 'string') invalid('serialized value must be a string');
  if (byteLength(serialized) > REGISTRY_SCAN_BATCH_MAX_SERIALIZED_BYTES) {
    invalid('serialized value exceeds the batch limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('serialized value is not valid JSON');
  }

  const batch = normalizeBatch(parsed);
  if (JSON.stringify(batch) !== serialized) invalid('serialized value is not canonical');
  return batch;
}

export function registryScanBatchDigest(batch: RegistryScanBatchV1): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(serializeRegistryScanBatch(batch)).digest('hex')}`;
}

export function registryEventStreamId(envelope: RegistryEventEnvelopeV1): string {
  const normalized = normalizeEnvelope(envelope);
  const blockNumber = BigInt(normalized.blockNumber);
  if (
    blockNumber > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT ||
    BigInt(normalized.logIndex) > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT
  ) {
    invalid('event log position exceeds the Redis stream ID limit');
  }
  if (blockNumber === 0n && normalized.logIndex === 0) {
    invalid('event log position cannot use the reserved Redis stream ID 0-0');
  }
  return `${normalized.blockNumber}-${normalized.logIndex}`;
}
