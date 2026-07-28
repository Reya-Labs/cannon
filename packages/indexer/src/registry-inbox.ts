import { parseRegistryCheckpoint, RegistryCheckpointV1, serializeRegistryCheckpoint } from './registry-checkpoint';
import { serializeRegistryEventEnvelope } from './registry-event-envelope';
import {
  createRegistryScanBatch,
  registryEventStreamId,
  registryScanBatchDigest,
  REGISTRY_SCAN_BATCH_MAX_EVENTS,
  REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT,
  RegistryScanBatchV1,
} from './registry-scan-batch';

export const REGISTRY_INBOX_STATE_VERSION = 1 as const;
export const REGISTRY_INBOX_STATE_MAX_SERIALIZED_BYTES = 4 * 1024;

export type RegistryInboxStateV1 = {
  version: typeof REGISTRY_INBOX_STATE_VERSION;
  registryChainId: number;
  checkpoint: RegistryCheckpointV1;
  scanFromBlock: string;
  scanToTimestamp: string;
  batchDigest: `sha256:${string}`;
  batchEventCount: number;
  streamLength: number;
};

export interface RegistryInboxRedis {
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<unknown>;
}

export type CommitRegistryScanBatchResult = {
  status: 'committed' | 'replayed';
  insertedEventCount: number;
  state: RegistryInboxStateV1;
};

type UnknownRecord = Record<string, unknown>;

const ABSENT_STATE = '__CANNON_REGISTRY_V2_ABSENT__';
const MAX_UINT256 = (1n << 256n) - 1n;

/*
 * The script writes stream entries before the state/checkpoint. A Redis command
 * failure can therefore leave only an identical event prefix, never an advanced
 * checkpoint. The next exact replay verifies that prefix byte-for-byte and
 * resumes it. Known conflicts are preflighted before any write.
 */
const COMMIT_SCAN_BATCH_SCRIPT = `
local stream_key = KEYS[1]
local state_key = KEYS[2]
local expected_state = ARGV[1]
local desired_state = ARGV[2]
local prior_stream_length = tonumber(ARGV[3])
local event_count = tonumber(ARGV[4])
local current_state = redis.call('GET', state_key)
local replaying = current_state == desired_state

if not replaying then
  if expected_state == '${ABSENT_STATE}' then
    if current_state then
      return redis.error_reply('registry inbox predecessor conflict')
    end
  elseif current_state ~= expected_state then
    return redis.error_reply('registry inbox predecessor conflict')
  end
end

local function split_stream_id(value)
  local separator = string.find(value, '-', 1, true)
  if not separator then
    return nil, nil
  end
  return string.sub(value, 1, separator - 1), string.sub(value, separator + 1)
end

local function compare_decimal(left, right)
  if string.len(left) < string.len(right) then return -1 end
  if string.len(left) > string.len(right) then return 1 end
  if left < right then return -1 end
  if left > right then return 1 end
  return 0
end

local function compare_stream_ids(left, right)
  local left_ms, left_sequence = split_stream_id(left)
  local right_ms, right_sequence = split_stream_id(right)
  if not left_ms or not right_ms then
    return nil
  end
  local milliseconds = compare_decimal(left_ms, right_ms)
  if milliseconds ~= 0 then return milliseconds end
  return compare_decimal(left_sequence, right_sequence)
end

local tail = redis.call('XREVRANGE', stream_key, '+', '-', 'COUNT', 1)
local last_stream_id = nil
if #tail > 0 then
  last_stream_id = tail[1][1]
end

local existing_count = 0
local missing = {}
local saw_missing = false
for index = 1, event_count do
  local argument_index = 5 + ((index - 1) * 2)
  local stream_id = ARGV[argument_index]
  local payload = ARGV[argument_index + 1]
  local existing = redis.call('XRANGE', stream_key, stream_id, stream_id, 'COUNT', 1)

  if #existing > 0 then
    local fields = existing[1][2]
    if saw_missing or #fields ~= 2 or fields[1] ~= 'event' or fields[2] ~= payload then
      return redis.error_reply('registry inbox event conflict')
    end
    existing_count = existing_count + 1
    missing[index] = false
  else
    if replaying then
      return redis.error_reply('registry inbox replay integrity conflict')
    end
    saw_missing = true
    if last_stream_id and compare_stream_ids(stream_id, last_stream_id) <= 0 then
      return redis.error_reply('registry inbox stream order conflict')
    end
    last_stream_id = stream_id
    missing[index] = true
  end
end

local actual_stream_length = redis.call('XLEN', stream_key)
if actual_stream_length ~= prior_stream_length + existing_count then
  if replaying then
    return redis.error_reply('registry inbox replay integrity conflict')
  end
  return redis.error_reply('registry inbox stream length conflict')
end

if replaying then
  if existing_count ~= event_count then
    return redis.error_reply('registry inbox replay integrity conflict')
  end
  return {0, 0}
end

local inserted = 0
for index = 1, event_count do
  if missing[index] then
    local argument_index = 5 + ((index - 1) * 2)
    redis.call('XADD', stream_key, ARGV[argument_index], 'event', ARGV[argument_index + 1])
    inserted = inserted + 1
  end
end

redis.call('SET', state_key, desired_state)
return {1, inserted}
`;

function invalid(label: string): never {
  throw new Error(`Invalid registry inbox state: ${label}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeChainId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('registryChainId must be a positive safe integer');
  }
  return value;
}

function normalizeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value === 0 ? 0 : value;
}

function normalizeCanonicalUint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid(`${label} must be a canonical unsigned integer string`);
  }
  if (BigInt(value) > MAX_UINT256) invalid(`${label} must fit uint256`);
  return value;
}

function normalizeDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    invalid('batchDigest must be a canonical SHA-256 digest');
  }
  return value as `sha256:${string}`;
}

function normalizeState(value: unknown): RegistryInboxStateV1 {
  if (!isRecord(value)) invalid('value must be an object');

  const expectedKeys = [
    'version',
    'registryChainId',
    'checkpoint',
    'scanFromBlock',
    'scanToTimestamp',
    'batchDigest',
    'batchEventCount',
    'streamLength',
  ];
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !hasOwn(value, key));
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length > 0) invalid(`missing ${missing.join(', ')}`);
  if (unexpected.length > 0) invalid(`unexpected fields: ${unexpected.join(', ')}`);
  if (value.version !== REGISTRY_INBOX_STATE_VERSION) {
    invalid(`unsupported version ${String(value.version)}`);
  }

  const registryChainId = normalizeChainId(value.registryChainId);
  let checkpoint: RegistryCheckpointV1;
  try {
    checkpoint = parseRegistryCheckpoint(
      serializeRegistryCheckpoint(value.checkpoint as RegistryCheckpointV1),
      registryChainId
    );
  } catch {
    return invalid('checkpoint is invalid');
  }

  const batchEventCount = normalizeSafeInteger(value.batchEventCount, 'batchEventCount');
  const streamLength = normalizeSafeInteger(value.streamLength, 'streamLength');
  if (batchEventCount > REGISTRY_SCAN_BATCH_MAX_EVENTS) {
    invalid(`batchEventCount exceeds the ${REGISTRY_SCAN_BATCH_MAX_EVENTS} item limit`);
  }
  if (batchEventCount > streamLength) invalid('batchEventCount exceeds streamLength');

  const scanFromBlock = normalizeCanonicalUint(value.scanFromBlock, 'scanFromBlock');
  const scanToTimestamp = normalizeCanonicalUint(value.scanToTimestamp, 'scanToTimestamp');
  const checkpointBlock = BigInt(checkpoint.blockNumber);
  if (
    BigInt(scanFromBlock) > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT ||
    checkpointBlock > REGISTRY_SCAN_BATCH_MAX_REDIS_STREAM_COMPONENT
  ) {
    invalid('scan block range exceeds the Redis stream ID limit');
  }
  if (BigInt(scanFromBlock) > checkpointBlock) invalid('checkpoint precedes scanFromBlock');

  return {
    version: REGISTRY_INBOX_STATE_VERSION,
    registryChainId,
    checkpoint,
    scanFromBlock,
    scanToTimestamp,
    batchDigest: normalizeDigest(value.batchDigest),
    batchEventCount,
    streamLength,
  };
}

function serializeRegistryInboxState(state: RegistryInboxStateV1): string {
  const serialized = JSON.stringify(normalizeState(state));
  if (Buffer.byteLength(serialized, 'utf8') > REGISTRY_INBOX_STATE_MAX_SERIALIZED_BYTES) {
    invalid('serialized value exceeds the state limit');
  }
  return serialized;
}

export function parseRegistryInboxState(serialized: string): RegistryInboxStateV1 {
  if (typeof serialized !== 'string') invalid('serialized value must be a string');
  if (Buffer.byteLength(serialized, 'utf8') > REGISTRY_INBOX_STATE_MAX_SERIALIZED_BYTES) {
    invalid('serialized value exceeds the state limit');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('serialized value is not valid JSON');
  }

  const state = normalizeState(parsed);
  if (JSON.stringify(state) !== serialized) invalid('serialized value is not canonical');
  return state;
}

export function registryInboxKeys(registryChainIdValue: number): {
  stream: string;
  state: string;
} {
  const registryChainId = normalizeChainId(registryChainIdValue);
  const hashTag = `{cannon-registry-v2:${registryChainId}}`;
  return {
    stream: `cannon:registry:v2:${hashTag}:inbox`,
    state: `cannon:registry:v2:${hashTag}:state`,
  };
}

function sameCheckpoint(left: RegistryCheckpointV1, right: RegistryCheckpointV1): boolean {
  return serializeRegistryCheckpoint(left) === serializeRegistryCheckpoint(right);
}

function normalizeBatch(batch: RegistryScanBatchV1): RegistryScanBatchV1 {
  return createRegistryScanBatch({
    registryChainId: batch.registryChainId,
    previousCheckpoint: batch.previousCheckpoint,
    scanFromBlock: batch.scanFromBlock,
    checkpoint: batch.checkpoint,
    scanToTimestamp: batch.scanToTimestamp,
    events: batch.events,
  });
}

export async function loadRegistryInboxState(
  redis: Pick<RegistryInboxRedis, 'get'>,
  registryChainId: number
): Promise<RegistryInboxStateV1 | null> {
  const serialized = await redis.get(registryInboxKeys(registryChainId).state);
  return serialized === null ? null : parseRegistryInboxState(serialized);
}

/**
 * Durably appends one canonical per-chain scan batch and only then advances its
 * V2 checkpoint state.
 *
 * The caller must first verify the previous checkpoint block hash against its
 * RPC. This dormant primitive does not read legacy `reg:*` state, project
 * events, create a consumer group, or activate the registry runtime.
 */
export async function commitRegistryScanBatch(
  redis: RegistryInboxRedis,
  input: RegistryScanBatchV1
): Promise<CommitRegistryScanBatchResult> {
  const batch = normalizeBatch(input);
  const keys = registryInboxKeys(batch.registryChainId);
  const digest = registryScanBatchDigest(batch);
  const currentSerialized = await redis.get(keys.state);
  const current = currentSerialized === null ? null : parseRegistryInboxState(currentSerialized);
  const isExactReplay = Boolean(
    current &&
      sameCheckpoint(current.checkpoint, batch.checkpoint) &&
      current.scanFromBlock === batch.scanFromBlock &&
      current.scanToTimestamp === batch.scanToTimestamp &&
      current.batchDigest === digest &&
      current.batchEventCount === batch.events.length
  );

  if (!isExactReplay && current === null) {
    if (batch.previousCheckpoint !== null) {
      throw new Error('Registry inbox predecessor conflict');
    }
  } else if (
    !isExactReplay &&
    current &&
    (batch.previousCheckpoint === null || !sameCheckpoint(current.checkpoint, batch.previousCheckpoint))
  ) {
    throw new Error('Registry inbox predecessor conflict');
  }

  const priorStreamLength = isExactReplay ? current!.streamLength - batch.events.length : current?.streamLength ?? 0;
  if (!Number.isSafeInteger(priorStreamLength) || priorStreamLength < 0) {
    throw new Error('Registry inbox state has an invalid stream length');
  }
  const desiredState: RegistryInboxStateV1 = isExactReplay
    ? current!
    : {
        version: REGISTRY_INBOX_STATE_VERSION,
        registryChainId: batch.registryChainId,
        checkpoint: batch.checkpoint,
        scanFromBlock: batch.scanFromBlock,
        scanToTimestamp: batch.scanToTimestamp,
        batchDigest: digest,
        batchEventCount: batch.events.length,
        streamLength: priorStreamLength + batch.events.length,
      };
  const desiredSerialized = serializeRegistryInboxState(desiredState);
  const eventArguments = batch.events.flatMap((event) => [
    registryEventStreamId(event),
    serializeRegistryEventEnvelope(event),
  ]);

  const rawResult = await redis.eval(COMMIT_SCAN_BATCH_SCRIPT, {
    keys: [keys.stream, keys.state],
    arguments: [
      currentSerialized ?? ABSENT_STATE,
      desiredSerialized,
      priorStreamLength.toString(),
      batch.events.length.toString(),
      ...eventArguments,
    ],
  });

  if (!Array.isArray(rawResult) || rawResult.length !== 2) {
    throw new Error('Registry inbox commit returned an invalid response');
  }
  const [committed, insertedEventCount] = rawResult;
  if (
    typeof committed !== 'number' ||
    ![0, 1].includes(committed) ||
    typeof insertedEventCount !== 'number' ||
    !Number.isSafeInteger(insertedEventCount) ||
    insertedEventCount < 0 ||
    insertedEventCount > batch.events.length ||
    (committed === 0 && insertedEventCount !== 0)
  ) {
    throw new Error('Registry inbox commit returned an invalid response');
  }

  return {
    status: committed === 1 ? 'committed' : 'replayed',
    insertedEventCount,
    state: desiredState,
  };
}
