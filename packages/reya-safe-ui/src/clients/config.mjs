import { fail } from './errors.mjs';

export const REYA_CHAIN_ID = 1729;

export const REYA_READ_LIMITS = Object.freeze({
  artifactBytes: 50 * 1024 * 1024,
  artifactDeadlineMs: 15_000,
  queryBytes: 512 * 1024,
  queryDeadlineMs: 8_000,
  responseChunks: 4_096,
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
const DEADLINE_KEYS = Object.freeze(['artifactDeadlineMs', 'queryDeadlineMs']);

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

function validateOrigin(value) {
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

  const serviceOrigin = validateOrigin(options.serviceOrigin);
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
  }

  return Object.freeze({
    artifactDeadlineMs,
    fetchImpl,
    queryDeadlineMs,
    serviceOrigin,
    verifyAbiSelector: options.verifyAbiSelector,
    verifyArtifactCid: options.verifyArtifactCid,
  });
}
