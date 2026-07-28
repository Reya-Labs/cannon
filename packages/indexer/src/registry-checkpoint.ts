export const REGISTRY_CHECKPOINT_VERSION = 1 as const;

const MAX_UINT256 = (1n << 256n) - 1n;

export type RegistryCheckpointV1 = {
  version: typeof REGISTRY_CHECKPOINT_VERSION;
  registryChainId: number;
  blockNumber: string;
  blockHash: `0x${string}`;
};

type UnknownRecord = Record<string, unknown>;

function invalid(label: string): never {
  throw new Error(`Invalid registry checkpoint: ${label}`);
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
  const expectedKeys = ['version', 'registryChainId', 'blockNumber', 'blockHash'];
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

function normalizeBlockNumber(value: unknown): string {
  let normalized: bigint;
  if (typeof value === 'bigint') {
    normalized = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    normalized = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    normalized = BigInt(value);
  } else {
    invalid('blockNumber must be an unsigned integer');
  }

  if (normalized < 0n || normalized > MAX_UINT256) invalid('blockNumber must fit uint256');
  return normalized.toString();
}

function expectCanonicalBlockNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid('blockNumber must be a canonical unsigned integer string');
  }
  return normalizeBlockNumber(value);
}

function normalizeBlockHash(value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    invalid('blockHash must be a 32-byte hex value');
  }
  return value.toLowerCase() as `0x${string}`;
}

function normalizeCheckpoint(value: unknown): RegistryCheckpointV1 {
  const checkpoint = expectRecord(value);
  assertExactKeys(checkpoint);

  if (checkpoint.version !== REGISTRY_CHECKPOINT_VERSION) {
    invalid(`unsupported version ${String(checkpoint.version)}`);
  }

  return {
    version: REGISTRY_CHECKPOINT_VERSION,
    registryChainId: normalizeChainId(checkpoint.registryChainId),
    blockNumber: expectCanonicalBlockNumber(checkpoint.blockNumber),
    blockHash: normalizeBlockHash(checkpoint.blockHash),
  };
}

export function createRegistryCheckpoint(input: {
  registryChainId: number;
  blockNumber: bigint | number;
  blockHash: string;
}): RegistryCheckpointV1 {
  return {
    version: REGISTRY_CHECKPOINT_VERSION,
    registryChainId: normalizeChainId(input.registryChainId),
    blockNumber: normalizeBlockNumber(input.blockNumber),
    blockHash: normalizeBlockHash(input.blockHash),
  };
}

export function serializeRegistryCheckpoint(checkpoint: RegistryCheckpointV1): string {
  return JSON.stringify(normalizeCheckpoint(checkpoint));
}

export function parseRegistryCheckpoint(serialized: string, expectedRegistryChainId?: number): RegistryCheckpointV1 {
  if (typeof serialized !== 'string') invalid('serialized value must be a string');

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('serialized value is not valid JSON');
  }

  const checkpoint = normalizeCheckpoint(parsed);
  if (JSON.stringify(checkpoint) !== serialized) invalid('serialized value is not canonical');
  if (expectedRegistryChainId !== undefined && checkpoint.registryChainId !== normalizeChainId(expectedRegistryChainId)) {
    invalid(`chain mismatch: expected ${expectedRegistryChainId}, received ${checkpoint.registryChainId}`);
  }

  return checkpoint;
}

/**
 * Returns the exact inclusive scan boundary.
 *
 * A missing key is the only cold-start signal. Any present but malformed,
 * legacy, wrong-chain or pre-boundary checkpoint fails closed.
 */
export function resolveRegistryScanStart(input: {
  serializedCheckpoint: string | null;
  registryChainId: number;
  coldStartBlock: bigint;
}): bigint {
  const registryChainId = normalizeChainId(input.registryChainId);
  const coldStartBlock = BigInt(normalizeBlockNumber(input.coldStartBlock));

  if (input.serializedCheckpoint === null) return coldStartBlock;
  if (typeof input.serializedCheckpoint !== 'string') invalid('serialized value must be a string or null');

  const checkpoint = parseRegistryCheckpoint(input.serializedCheckpoint, registryChainId);
  const checkpointBlock = BigInt(checkpoint.blockNumber);
  if (checkpointBlock < coldStartBlock) {
    invalid(`blockNumber ${checkpoint.blockNumber} precedes cold-start boundary ${coldStartBlock}`);
  }
  if (checkpointBlock === MAX_UINT256) invalid('blockNumber has no valid successor');

  return checkpointBlock + 1n;
}
