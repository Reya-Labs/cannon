import {
  getContentCID,
} from '@usecannon/artifact-codec';
import { Inflate } from 'pako';

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const IPFS_URL_PATTERN = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const DEFAULT_MAXIMUM_BYTES = 50 * 1024 * 1024;
const MAXIMUM_DECODED_BYTES = 128 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 64;
const MAXIMUM_JSON_NODES = 1_000_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateOptions(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preview artifact loader options are invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('preview artifact loader options are invalid');
  }
  const expected = new Set(['maximumBytes', 'readArtifact']);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < 1 ||
    keys.length > expected.size ||
    keys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    throw new Error('preview artifact loader options are invalid');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('preview artifact loader options are invalid');
    }
  }
  return {
    maximumBytes: Object.hasOwn(value, 'maximumBytes')
      ? value.maximumBytes
      : DEFAULT_MAXIMUM_BYTES,
    readArtifact: value.readArtifact,
  };
}

function artifactCid(url) {
  if (typeof url !== 'string') {
    throw new Error('preview artifact URL is invalid');
  }
  const match = IPFS_URL_PATTERN.exec(url);
  if (!match || !CID_V0_PATTERN.test(match[1])) {
    throw new Error('preview artifact URL is invalid');
  }
  return match[1];
}

function readOnlyFailure() {
  throw new Error('preview artifact loader is read-only');
}

function decodeBoundedArtifact(bytes) {
  const chunks = [];
  let size = 0;
  const inflater = new Inflate();
  inflater.onData = (chunk) => {
    size += chunk.byteLength;
    if (size > MAXIMUM_DECODED_BYTES) {
      throw new Error('preview artifact decoded bytes exceed their limit');
    }
    chunks.push(new Uint8Array(chunk));
  };
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
    inflater.push(
      bytes.subarray(offset, Math.min(bytes.byteLength, offset + 64 * 1024)),
      offset + 64 * 1024 >= bytes.byteLength
    );
    if (inflater.err) {
      throw new Error('preview artifact payload is invalid');
    }
  }
  const decoded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch {
    throw new Error('preview artifact payload is invalid');
  }
}

function validateJsonStructure(value) {
  let nodes = 0;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > MAXIMUM_JSON_NODES || depth > MAXIMUM_JSON_DEPTH) {
      throw new Error('preview artifact JSON exceeds structural limits');
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
      return;
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('preview artifact JSON is invalid');
    }
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
        throw new Error('preview artifact JSON contains a forbidden key');
      }
      visit(candidate[key], depth + 1);
    }
  };
  visit(value, 0);
}

/**
 * Creates a read-only Cannon loader backed by the trusted main-document broker.
 *
 * The loader accepts only canonical `ipfs://<CIDv0>` URLs, verifies the raw
 * compressed bytes against the requested CID, inflates one JSON artifact, and
 * exposes no write, list, or removal capability.
 *
 * @param {{
 *   maximumBytes?: number,
 *   readArtifact: (cid: string) => Promise<Uint8Array>,
 * }} options
 */
export function createReadOnlyArtifactLoader(options) {
  const canonical = validateOptions(options);
  if (
    typeof canonical.readArtifact !== 'function' ||
    !Number.isSafeInteger(canonical.maximumBytes) ||
    canonical.maximumBytes < 1 ||
    canonical.maximumBytes > DEFAULT_MAXIMUM_BYTES
  ) {
    throw new Error('preview artifact loader options are invalid');
  }

  return Object.freeze({
    getLabel() {
      return 'verified read-only artifact broker';
    },
    async read(url) {
      const cid = artifactCid(url);
      const bytes = await canonical.readArtifact(cid);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > canonical.maximumBytes
      ) {
        throw new Error('preview artifact bytes are invalid');
      }
      if ((await getContentCID(bytes)) !== cid) {
        throw new Error('preview artifact CID verification failed');
      }

      let decoded;
      try {
        decoded = decodeBoundedArtifact(bytes);
      } catch {
        throw new Error('preview artifact payload is invalid');
      }
      if (
        decoded === null ||
        typeof decoded !== 'object' ||
        Array.isArray(decoded)
      ) {
        throw new Error('preview artifact payload is invalid');
      }
      validateJsonStructure(decoded);
      return decoded;
    },
    list: readOnlyFailure,
    put: readOnlyFailure,
    remove: readOnlyFailure,
  });
}
