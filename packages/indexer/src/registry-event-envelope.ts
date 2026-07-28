export const REGISTRY_EVENT_ENVELOPE_VERSION = 1 as const;

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export type CanonicalAddress = `0x${string}`;
export type CanonicalBytes32 = `0x${string}`;
export type CanonicalUint = string;

type PackagePublishFieldsV1 = {
  packageName: CanonicalBytes32;
  tag: CanonicalBytes32;
  variant: CanonicalBytes32;
  deployUrl: string;
  metaUrl: string;
  owner: CanonicalAddress;
};

export type LegacyPackagePublishEventV1 = PackagePublishFieldsV1 & {
  name: 'PackagePublish';
  feePaid: null;
};

export type PackagePublishWithFeeEventV1 = PackagePublishFieldsV1 & {
  name: 'PackagePublishWithFee';
  feePaid: CanonicalUint;
};

export type PackagePublishEventV1 = LegacyPackagePublishEventV1 | PackagePublishWithFeeEventV1;

export type TagPublishEventV1 = {
  name: 'TagPublish';
  packageName: CanonicalBytes32;
  tag: CanonicalBytes32;
  variant: CanonicalBytes32;
  versionOfTag: CanonicalBytes32;
};

export type PackageUnpublishEventV1 = {
  name: 'PackageUnpublish';
  packageName: CanonicalBytes32;
  tag: CanonicalBytes32;
  variant: CanonicalBytes32;
  owner: CanonicalAddress;
};

export type PackageOwnerChangedEventV1 = {
  name: 'PackageOwnerChanged';
  packageName: CanonicalBytes32;
  owner: CanonicalAddress;
};

export type PackagePublishersChangedEventV1 = {
  name: 'PackagePublishersChanged';
  packageName: CanonicalBytes32;
  publishers: CanonicalAddress[];
};

export type RegistryEventV1 =
  | PackagePublishEventV1
  | TagPublishEventV1
  | PackageUnpublishEventV1
  | PackageOwnerChangedEventV1
  | PackagePublishersChangedEventV1;

/**
 * JSON-safe, canonical representation of one decoded Cannon registry log.
 *
 * Integer values that originate as bigint are canonical base-10 strings. The
 * event identity is derived only from its immutable chain/log position.
 */
export type RegistryEventEnvelopeV1 = {
  version: typeof REGISTRY_EVENT_ENVELOPE_VERSION;
  id: string;
  registryChainId: number;
  blockNumber: CanonicalUint;
  blockHash: CanonicalBytes32;
  transactionHash: CanonicalBytes32;
  logIndex: number;
  timestamp: CanonicalUint;
  event: RegistryEventV1;
};

type UnknownRecord = Record<string, unknown>;

function invalid(label: string): never {
  throw new Error(`Invalid registry event envelope: ${label}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function required(value: UnknownRecord, key: string, label: string): unknown {
  if (!hasOwn(value, key)) invalid(`${label}.${key} is required`);
  return value[key];
}

function assertExactKeys(value: UnknownRecord, expectedKeys: readonly string[], label: string): void {
  const expected = new Set(expectedKeys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !hasOwn(value, key));

  if (missing.length > 0) invalid(`${label} is missing ${missing.join(', ')}`);
  if (unexpected.length > 0) invalid(`${label} contains unexpected fields: ${unexpected.join(', ')}`);
}

function normalizeChainId(value: unknown): number {
  const normalized = normalizeSafeInteger(value, 'registryChainId');
  if (normalized < 1) invalid('registryChainId must be positive');
  return normalized;
}

function normalizeSafeInteger(value: unknown, label: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_SAFE_INTEGER) invalid(`${label} must be a non-negative safe integer`);
    return Number(value);
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }

  return value === 0 ? 0 : value;
}

function normalizeUint(value: unknown, label: string): CanonicalUint {
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

function expectCanonicalUint(value: unknown, label: string): CanonicalUint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid(`${label} must be a canonical unsigned integer string`);
  }

  return normalizeUint(value, label);
}

function normalizeHex(value: unknown, bytes: number, label: string): `0x${string}` {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    invalid(`${label} must be a ${bytes}-byte hex value`);
  }
  return value.toLowerCase() as `0x${string}`;
}

function normalizeBytes32(value: unknown, label: string): CanonicalBytes32 {
  return normalizeHex(value, 32, label);
}

function normalizeAddress(value: unknown, label: string): CanonicalAddress {
  return normalizeHex(value, 20, label);
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function decodeRawEvent(rawLog: UnknownRecord): RegistryEventV1 {
  const eventName = expectString(required(rawLog, 'eventName', 'log'), 'log.eventName');
  const args = expectRecord(required(rawLog, 'args', 'log'), 'log.args');

  switch (eventName) {
    case 'PackagePublish': {
      assertExactKeys(args, ['name', 'tag', 'variant', 'deployUrl', 'metaUrl', 'owner'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        tag: normalizeBytes32(args.tag, 'log.args.tag'),
        variant: normalizeBytes32(args.variant, 'log.args.variant'),
        deployUrl: expectString(args.deployUrl, 'log.args.deployUrl'),
        metaUrl: expectString(args.metaUrl, 'log.args.metaUrl'),
        owner: normalizeAddress(args.owner, 'log.args.owner'),
        feePaid: null,
      };
    }
    case 'PackagePublishWithFee': {
      assertExactKeys(args, ['name', 'tag', 'variant', 'deployUrl', 'metaUrl', 'owner', 'feePaid'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        tag: normalizeBytes32(args.tag, 'log.args.tag'),
        variant: normalizeBytes32(args.variant, 'log.args.variant'),
        deployUrl: expectString(args.deployUrl, 'log.args.deployUrl'),
        metaUrl: expectString(args.metaUrl, 'log.args.metaUrl'),
        owner: normalizeAddress(args.owner, 'log.args.owner'),
        feePaid: normalizeUint(args.feePaid, 'log.args.feePaid'),
      };
    }
    case 'TagPublish': {
      assertExactKeys(args, ['name', 'tag', 'variant', 'versionOfTag'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        tag: normalizeBytes32(args.tag, 'log.args.tag'),
        variant: normalizeBytes32(args.variant, 'log.args.variant'),
        versionOfTag: normalizeBytes32(args.versionOfTag, 'log.args.versionOfTag'),
      };
    }
    case 'PackageUnpublish': {
      assertExactKeys(args, ['name', 'tag', 'variant', 'owner'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        tag: normalizeBytes32(args.tag, 'log.args.tag'),
        variant: normalizeBytes32(args.variant, 'log.args.variant'),
        owner: normalizeAddress(args.owner, 'log.args.owner'),
      };
    }
    case 'PackageOwnerChanged': {
      assertExactKeys(args, ['name', 'owner'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        owner: normalizeAddress(args.owner, 'log.args.owner'),
      };
    }
    case 'PackagePublishersChanged': {
      assertExactKeys(args, ['name', 'publisher'], 'log.args');
      return {
        name: eventName,
        packageName: normalizeBytes32(args.name, 'log.args.name'),
        publishers: expectArray(args.publisher, 'log.args.publisher').map((publisher, index) =>
          normalizeAddress(publisher, `log.args.publisher[${index}]`)
        ),
      };
    }
    default:
      return invalid(`unsupported event name ${eventName}`);
  }
}

function normalizeCanonicalEvent(value: unknown): RegistryEventV1 {
  const event = expectRecord(value, 'event');
  const eventName = expectString(required(event, 'name', 'event'), 'event.name');

  switch (eventName) {
    case 'PackagePublish': {
      assertExactKeys(event, ['name', 'packageName', 'tag', 'variant', 'deployUrl', 'metaUrl', 'owner', 'feePaid'], 'event');
      if (event.feePaid !== null) invalid('event.feePaid must be null when the legacy event omitted fee data');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        tag: normalizeBytes32(event.tag, 'event.tag'),
        variant: normalizeBytes32(event.variant, 'event.variant'),
        deployUrl: expectString(event.deployUrl, 'event.deployUrl'),
        metaUrl: expectString(event.metaUrl, 'event.metaUrl'),
        owner: normalizeAddress(event.owner, 'event.owner'),
        feePaid: null,
      };
    }
    case 'PackagePublishWithFee': {
      assertExactKeys(event, ['name', 'packageName', 'tag', 'variant', 'deployUrl', 'metaUrl', 'owner', 'feePaid'], 'event');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        tag: normalizeBytes32(event.tag, 'event.tag'),
        variant: normalizeBytes32(event.variant, 'event.variant'),
        deployUrl: expectString(event.deployUrl, 'event.deployUrl'),
        metaUrl: expectString(event.metaUrl, 'event.metaUrl'),
        owner: normalizeAddress(event.owner, 'event.owner'),
        feePaid: expectCanonicalUint(event.feePaid, 'event.feePaid'),
      };
    }
    case 'TagPublish': {
      assertExactKeys(event, ['name', 'packageName', 'tag', 'variant', 'versionOfTag'], 'event');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        tag: normalizeBytes32(event.tag, 'event.tag'),
        variant: normalizeBytes32(event.variant, 'event.variant'),
        versionOfTag: normalizeBytes32(event.versionOfTag, 'event.versionOfTag'),
      };
    }
    case 'PackageUnpublish': {
      assertExactKeys(event, ['name', 'packageName', 'tag', 'variant', 'owner'], 'event');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        tag: normalizeBytes32(event.tag, 'event.tag'),
        variant: normalizeBytes32(event.variant, 'event.variant'),
        owner: normalizeAddress(event.owner, 'event.owner'),
      };
    }
    case 'PackageOwnerChanged': {
      assertExactKeys(event, ['name', 'packageName', 'owner'], 'event');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        owner: normalizeAddress(event.owner, 'event.owner'),
      };
    }
    case 'PackagePublishersChanged': {
      assertExactKeys(event, ['name', 'packageName', 'publishers'], 'event');
      return {
        name: eventName,
        packageName: normalizeBytes32(event.packageName, 'event.packageName'),
        publishers: expectArray(event.publishers, 'event.publishers').map((publisher, index) =>
          normalizeAddress(publisher, `event.publishers[${index}]`)
        ),
      };
    }
    default:
      return invalid(`unsupported canonical event name ${eventName}`);
  }
}

export function createRegistryEventId(input: {
  registryChainId: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}): string {
  const registryChainId = normalizeChainId(input.registryChainId);
  const blockHash = normalizeBytes32(input.blockHash, 'blockHash');
  const transactionHash = normalizeBytes32(input.transactionHash, 'transactionHash');
  const logIndex = normalizeSafeInteger(input.logIndex, 'logIndex');

  return `cannon-registry-event:v1:${registryChainId}:${blockHash}:${transactionHash}:${logIndex}`;
}

function normalizeEnvelope(value: unknown): RegistryEventEnvelopeV1 {
  const envelope = expectRecord(value, 'envelope');
  assertExactKeys(
    envelope,
    ['version', 'id', 'registryChainId', 'blockNumber', 'blockHash', 'transactionHash', 'logIndex', 'timestamp', 'event'],
    'envelope'
  );

  if (envelope.version !== REGISTRY_EVENT_ENVELOPE_VERSION) {
    invalid(`unsupported version ${String(envelope.version)}`);
  }

  const registryChainId = normalizeChainId(envelope.registryChainId);
  const blockNumber = expectCanonicalUint(envelope.blockNumber, 'blockNumber');
  const blockHash = normalizeBytes32(envelope.blockHash, 'blockHash');
  const transactionHash = normalizeBytes32(envelope.transactionHash, 'transactionHash');
  const logIndex = normalizeSafeInteger(envelope.logIndex, 'logIndex');
  const timestamp = expectCanonicalUint(envelope.timestamp, 'timestamp');
  const event = normalizeCanonicalEvent(envelope.event);
  const id = expectString(envelope.id, 'id');
  const expectedId = createRegistryEventId({ registryChainId, blockHash, transactionHash, logIndex });

  if (id !== expectedId) invalid('id does not match the immutable log position');

  return {
    version: REGISTRY_EVENT_ENVELOPE_VERSION,
    id: expectedId,
    registryChainId,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    timestamp,
    event,
  };
}

/**
 * Converts one viem-decoded registry log into the V1 durable envelope without
 * retaining bigint values or assuming fields shared by unrelated event types.
 */
export function decodeRegistryEventEnvelope(registryChainIdValue: number, rawValue: unknown): RegistryEventEnvelopeV1 {
  const rawLog = expectRecord(rawValue, 'log');
  const registryChainId = normalizeChainId(registryChainIdValue);
  const blockNumber = normalizeUint(required(rawLog, 'blockNumber', 'log'), 'blockNumber');
  const blockHash = normalizeBytes32(required(rawLog, 'blockHash', 'log'), 'blockHash');
  const transactionHash = normalizeBytes32(required(rawLog, 'transactionHash', 'log'), 'transactionHash');
  const logIndex = normalizeSafeInteger(required(rawLog, 'logIndex', 'log'), 'logIndex');
  const timestamp = normalizeUint(required(rawLog, 'timestamp', 'log'), 'timestamp');
  const event = decodeRawEvent(rawLog);
  const id = createRegistryEventId({ registryChainId, blockHash, transactionHash, logIndex });

  return {
    version: REGISTRY_EVENT_ENVELOPE_VERSION,
    id,
    registryChainId,
    blockNumber,
    blockHash,
    transactionHash,
    logIndex,
    timestamp,
    event,
  };
}

export function serializeRegistryEventEnvelope(envelope: RegistryEventEnvelopeV1): string {
  return JSON.stringify(normalizeEnvelope(envelope));
}

export function parseRegistryEventEnvelope(serialized: string): RegistryEventEnvelopeV1 {
  if (typeof serialized !== 'string') invalid('serialized value must be a string');

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('serialized value is not valid JSON');
  }

  const envelope = normalizeEnvelope(parsed);
  if (JSON.stringify(envelope) !== serialized) invalid('serialized value is not canonical');
  return envelope;
}

/**
 * Collapses byte-identical replay duplicates while failing closed if the same
 * immutable log position is ever associated with conflicting content.
 */
export function deduplicateRegistryEventEnvelopes(envelopes: readonly RegistryEventEnvelopeV1[]): RegistryEventEnvelopeV1[] {
  const unique = new Map<string, { envelope: RegistryEventEnvelopeV1; serialized: string }>();

  for (const candidate of envelopes) {
    const serialized = serializeRegistryEventEnvelope(candidate);
    const envelope = parseRegistryEventEnvelope(serialized);
    const previous = unique.get(envelope.id);

    if (previous && previous.serialized !== serialized) {
      invalid(`conflicting duplicate for ${envelope.id}`);
    }
    if (!previous) unique.set(envelope.id, { envelope, serialized });
  }

  return [...unique.values()].map(({ envelope }) => envelope);
}
