import { compress, getContentCID } from '@usecannon/artifact-codec';

const CID_URL_PATTERN = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const MAX_EPHEMERAL_ARTIFACTS = 256;
const MAX_EPHEMERAL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_EPHEMERAL_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 1_000_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function unsupportedJsonObject(candidate) {
  const kind = Buffer.isBuffer(candidate)
    ? 'Buffer'
    : ArrayBuffer.isView(candidate)
    ? 'typed array'
    : candidate instanceof Map
    ? 'Map'
    : candidate instanceof Set
    ? 'Set'
    : 'object';
  return new Error(`ephemeral artifact is not JSON serializable: ${kind}`);
}

function boundedJson(value, maximumBytes) {
  let nodes = 0;
  let observedBytes = 0;
  const addBytes = (bytes) => {
    observedBytes += bytes;
    if (observedBytes > maximumBytes) {
      throw new Error('ephemeral artifact bytes exceed their limit');
    }
  };
  const addJsonString = (text) => {
    addBytes(2);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (
        code === 0x22 ||
        code === 0x5c ||
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        addBytes(2);
      } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const low = text.charCodeAt(index + 1);
          if (low >= 0xdc00 && low <= 0xdfff) {
            addBytes(4);
            index += 1;
            continue;
          }
        }
        addBytes(6);
      } else if (code <= 0x7f) {
        addBytes(1);
      } else if (code <= 0x7ff) {
        addBytes(2);
      } else {
        addBytes(3);
      }
    }
  };
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error('ephemeral artifact JSON exceeds structural limits');
    }
    if (candidate === null || typeof candidate === 'boolean') {
      addBytes(candidate === null || candidate === true ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      const normalized = Object.is(candidate, -0) ? 0 : candidate;
      addBytes(String(normalized).length);
      return normalized;
    }
    if (typeof candidate === 'bigint') {
      const normalized = candidate.toString();
      addJsonString(normalized);
      return normalized;
    }
    if (typeof candidate === 'string') {
      addJsonString(candidate);
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const keys = Reflect.ownKeys(candidate);
      if (
        keys.length !== candidate.length + 1 ||
        !keys.every(
          (key, index) =>
            key === 'length' ||
            (typeof key === 'string' &&
              Number.isSafeInteger(Number(key)) &&
              Number(key) === index)
        )
      ) {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      addBytes(2 + Math.max(0, candidate.length - 1));
      return candidate.map((child) => visit(child, depth + 1));
    }
    if (
      typeof candidate === 'object' &&
      Object.getPrototypeOf(candidate) === Date.prototype
    ) {
      if (Reflect.ownKeys(candidate).length !== 0) {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      let normalized;
      try {
        normalized = Date.prototype.toISOString.call(candidate);
      } catch {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      addJsonString(normalized);
      return normalized;
    }
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))
    ) {
      throw unsupportedJsonObject(candidate);
    }
    const normalized = Object.create(null);
    let observedKeys = 0;
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) {
        throw new Error('ephemeral artifact is not JSON serializable');
      }
      if (observedKeys > 0) addBytes(1);
      observedKeys += 1;
      addJsonString(key);
      addBytes(1);
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: visit(descriptor.value, depth + 1),
        writable: true,
      });
    }
    addBytes(2);
    return normalized;
  };
  const normalized = visit(value, 0);

  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    throw new Error('ephemeral artifact is not JSON serializable');
  }
  if (
    typeof serialized !== 'string' ||
    Buffer.byteLength(serialized, 'utf8') > maximumBytes
  ) {
    throw new Error('ephemeral artifact bytes exceed their limit');
  }
  return serialized;
}

/**
 * Adds a process-local, content-addressed write overlay to a verified
 * read-only artifact loader. No bytes leave the simulator.
 */
export function createEphemeralArtifactOverlay({
  allowedCids,
  baseLoader,
  maximumArtifactBytes = MAX_EPHEMERAL_ARTIFACT_BYTES,
  maximumTotalBytes = MAX_EPHEMERAL_TOTAL_BYTES,
}) {
  if (
    !(allowedCids instanceof Set) ||
    baseLoader === null ||
    typeof baseLoader !== 'object' ||
    typeof baseLoader.read !== 'function' ||
    !Number.isSafeInteger(maximumArtifactBytes) ||
    maximumArtifactBytes < 1 ||
    maximumArtifactBytes > MAX_EPHEMERAL_ARTIFACT_BYTES ||
    !Number.isSafeInteger(maximumTotalBytes) ||
    maximumTotalBytes < maximumArtifactBytes ||
    maximumTotalBytes > MAX_EPHEMERAL_TOTAL_BYTES
  ) {
    throw new Error('ephemeral artifact overlay options are invalid');
  }
  const values = new Map();
  let totalBytes = 0;

  const loader = Object.freeze({
    getLabel() {
      return 'verified cache plus ephemeral content-addressed overlay';
    },
    async read(url) {
      const match = typeof url === 'string' && CID_URL_PATTERN.exec(url);
      if (!match) throw new Error('ephemeral artifact URL is invalid');
      if (values.has(match[1])) return JSON.parse(values.get(match[1]));
      return baseLoader.read(url);
    },
    async put(value) {
      const serialized = boundedJson(value, maximumArtifactBytes);
      const serializedBytes = Buffer.byteLength(serialized, 'utf8');
      const bytes = compress(serialized);
      if (bytes.byteLength > maximumArtifactBytes) {
        throw new Error('ephemeral artifact bytes exceed their limit');
      }
      const cid = await getContentCID(bytes);
      if (!values.has(cid) && values.size >= MAX_EPHEMERAL_ARTIFACTS) {
        throw new Error('ephemeral artifact count exceeds its limit');
      }
      if (!values.has(cid)) {
        if (totalBytes + serializedBytes > maximumTotalBytes) {
          throw new Error('ephemeral artifact bytes exceed their limit');
        }
        values.set(cid, serialized);
        allowedCids.add(cid);
        totalBytes += serializedBytes;
      }
      return `ipfs://${cid}`;
    },
    async list() {
      return [...values.keys()].sort().map((cid) => `ipfs://${cid}`);
    },
    remove() {
      throw new Error('ephemeral artifacts cannot be removed during a run');
    },
  });

  return Object.freeze({
    allowedCids,
    loader,
  });
}
