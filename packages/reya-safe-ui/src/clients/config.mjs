import { fail } from './errors.mjs';

export const REYA_CHAIN_ID = 1729;

export const REYA_READ_LIMITS = Object.freeze({
  artifactBytes: 50 * 1024 * 1024,
  artifactDeadlineMs: 15_000,
  queryBytes: 512 * 1024,
  queryDeadlineMs: 8_000,
  registryDeadlineMs: 8_000,
  registryRequestBytes: 512,
  registryResponseBytes: 4 * 1024,
  responseChunks: 4_096,
  rpcRequestBytes: 128 * 1024,
  rpcResponseBytes: 2 * 1024 * 1024,
  rpcDeadlineMs: 12_000,
  sourceBytes: 8 * 1024 * 1024,
  sourceDeadlineMs: 15_000,
});

const ORIGIN_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/;
const TOP_LEVEL_KEYS = Object.freeze([
  'deadlines',
  'fetchImpl',
  'serviceOrigin',
  'verifyAbiSelector',
  'verifyArtifactCid',
]);
const DEADLINE_KEYS = Object.freeze([
  'artifactDeadlineMs',
  'queryDeadlineMs',
  'registryDeadlineMs',
  'rpcDeadlineMs',
  'sourceDeadlineMs',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(value, allowed, required = []) {
  if (!isPlainObject(value)) fail('INVALID_CONFIGURATION');
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key)
    )
  ) {
    fail('INVALID_CONFIGURATION');
  }
}

export function validateServiceOrigin(value) {
  if (typeof value !== 'string' || value.length > 253) {
    fail('INVALID_CONFIGURATION');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    fail('INVALID_CONFIGURATION');
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !ORIGIN_HOST_PATTERN.test(url.hostname) ||
    value !== url.origin
  ) {
    fail('INVALID_CONFIGURATION');
  }

  return url.origin;
}

function validateDeadline(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('INVALID_CONFIGURATION');
  }
  return value;
}

export function validateReadClientOptions(options) {
  assertAllowedKeys(options, TOP_LEVEL_KEYS, [
    'serviceOrigin',
    'verifyAbiSelector',
    'verifyArtifactCid',
  ]);

  const serviceOrigin = validateServiceOrigin(options.serviceOrigin);
  if (
    typeof options.verifyAbiSelector !== 'function' ||
    typeof options.verifyArtifactCid !== 'function'
  ) {
    fail('INVALID_CONFIGURATION');
  }

  const fetchImpl = Object.hasOwn(options, 'fetchImpl')
    ? options.fetchImpl
    : globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('INVALID_CONFIGURATION');

  let queryDeadlineMs = REYA_READ_LIMITS.queryDeadlineMs;
  let artifactDeadlineMs = REYA_READ_LIMITS.artifactDeadlineMs;
  let rpcDeadlineMs = REYA_READ_LIMITS.rpcDeadlineMs;
  let registryDeadlineMs = REYA_READ_LIMITS.registryDeadlineMs;
  let sourceDeadlineMs = REYA_READ_LIMITS.sourceDeadlineMs;
  if (Object.hasOwn(options, 'deadlines')) {
    assertAllowedKeys(options.deadlines, DEADLINE_KEYS);
    if (
      !Object.hasOwn(options.deadlines, 'queryDeadlineMs') ||
      !Object.hasOwn(options.deadlines, 'artifactDeadlineMs')
    ) {
      fail('INVALID_CONFIGURATION');
    }
    queryDeadlineMs = validateDeadline(
      options.deadlines.queryDeadlineMs,
      REYA_READ_LIMITS.queryDeadlineMs
    );
    artifactDeadlineMs = validateDeadline(
      options.deadlines.artifactDeadlineMs,
      REYA_READ_LIMITS.artifactDeadlineMs
    );
    if (Object.hasOwn(options.deadlines, 'rpcDeadlineMs')) {
      rpcDeadlineMs = validateDeadline(
        options.deadlines.rpcDeadlineMs,
        REYA_READ_LIMITS.rpcDeadlineMs
      );
    }
    if (Object.hasOwn(options.deadlines, 'registryDeadlineMs')) {
      registryDeadlineMs = validateDeadline(
        options.deadlines.registryDeadlineMs,
        REYA_READ_LIMITS.registryDeadlineMs
      );
    }
    if (Object.hasOwn(options.deadlines, 'sourceDeadlineMs')) {
      sourceDeadlineMs = validateDeadline(
        options.deadlines.sourceDeadlineMs,
        REYA_READ_LIMITS.sourceDeadlineMs
      );
    }
  }

  return Object.freeze({
    artifactDeadlineMs,
    fetchImpl,
    queryDeadlineMs,
    registryDeadlineMs,
    rpcDeadlineMs,
    serviceOrigin,
    sourceDeadlineMs,
    verifyAbiSelector: options.verifyAbiSelector,
    verifyArtifactCid: options.verifyArtifactCid,
  });
}
