import toml from '@iarna/toml';
import { REYA_READ_LIMITS } from './config.mjs';
import { fail } from './errors.mjs';
import { boundedRequest, parseJson } from './transport.mjs';

export const SOURCE_REPOSITORY = 'Reya-Labs/reya-deployments';
export const SOURCE_ROOT = 'packages/tomls/src/omnibus/reya_network.toml';
export const SOURCE_ROUTE_PREFIX = '/source/reya-deployments/';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FILES = 512;
const MAX_GRAPH_DEPTH = 16;
const BUNDLE_KEYS = Object.freeze([
  'bundleSha256',
  'commit',
  'files',
  'repository',
  'root',
  'schemaVersion',
]);
const FILE_KEYS = Object.freeze(['content', 'path', 'sha256']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function validSourcePath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !value.startsWith('packages/tomls/src/') ||
    !value.endsWith('.toml') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return false;
  }
  return value
    .split('/')
    .every((component) => component && component !== '.' && component !== '..');
}

async function sha256(value) {
  try {
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  } catch {
    fail('RESPONSE_REJECTED');
  }
}

function includePath(current, include) {
  if (
    typeof include !== 'string' ||
    !include ||
    include.length > 512 ||
    include.includes('\0') ||
    include.includes('\\') ||
    include.startsWith('/')
  ) {
    fail('RESPONSE_REJECTED');
  }
  const components = current.split('/');
  components.pop();
  for (const component of include.split('/')) {
    if (!component || component === '.') continue;
    if (component === '..') {
      if (components.length === 0) fail('RESPONSE_REJECTED');
      components.pop();
    } else {
      components.push(component);
    }
  }
  const resolved = components.join('/');
  if (!validSourcePath(resolved)) fail('RESPONSE_REJECTED');
  return resolved;
}

function validateClosure(files) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const reachable = new Set();
  const active = new Set();
  const orderedPaths = [];

  const visit = (path, depth) => {
    if (depth > MAX_GRAPH_DEPTH || active.has(path)) {
      fail('RESPONSE_REJECTED');
    }
    if (reachable.has(path)) return;
    const file = byPath.get(path);
    if (!file) fail('RESPONSE_REJECTED');
    let parsed;
    try {
      parsed = toml.parse(file.content);
    } catch {
      fail('RESPONSE_REJECTED');
    }
    if (!isPlainObject(parsed)) fail('RESPONSE_REJECTED');
    const include = Object.hasOwn(parsed, 'include')
      ? parsed.include
      : undefined;
    if (
      include !== undefined &&
      (!Array.isArray(include) ||
        include.length > MAX_FILES ||
        include.some((value) => typeof value !== 'string'))
    ) {
      fail('RESPONSE_REJECTED');
    }

    reachable.add(path);
    orderedPaths.push(path);
    active.add(path);
    for (const additional of include ?? []) {
      visit(includePath(path, additional), depth + 1);
    }
    active.delete(path);
  };

  visit(SOURCE_ROOT, 0);
  if (reachable.size !== files.length) fail('RESPONSE_REJECTED');
  return orderedPaths.map((path) => byPath.get(path));
}

async function validateBundle(value, expectedCommit) {
  if (
    !exactKeys(value, BUNDLE_KEYS) ||
    value.schemaVersion !== 1 ||
    value.repository !== SOURCE_REPOSITORY ||
    value.commit !== expectedCommit ||
    value.root !== SOURCE_ROOT ||
    !DIGEST_PATTERN.test(value.bundleSha256) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_FILES
  ) {
    fail('RESPONSE_REJECTED');
  }

  const files = [];
  let previousPath = '';
  let hasRoot = false;
  for (const candidate of value.files) {
    if (
      !exactKeys(candidate, FILE_KEYS) ||
      !validSourcePath(candidate.path) ||
      typeof candidate.content !== 'string' ||
      !DIGEST_PATTERN.test(candidate.sha256) ||
      candidate.path <= previousPath
    ) {
      fail('RESPONSE_REJECTED');
    }
    if ((await sha256(candidate.content)) !== candidate.sha256) {
      fail('RESPONSE_REJECTED');
    }
    previousPath = candidate.path;
    hasRoot ||= candidate.path === SOURCE_ROOT;
    files.push(
      Object.freeze({
        content: candidate.content,
        path: candidate.path,
        sha256: candidate.sha256,
      })
    );
  }
  if (!hasRoot) fail('RESPONSE_REJECTED');
  const orderedFiles = validateClosure(files);

  const canonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: expectedCommit,
    root: SOURCE_ROOT,
    files,
  };
  if ((await sha256(JSON.stringify(canonical))) !== value.bundleSha256) {
    fail('RESPONSE_REJECTED');
  }
  return Object.freeze({
    ...canonical,
    bundleSha256: value.bundleSha256,
    files: Object.freeze(files),
    orderedFiles: Object.freeze(orderedFiles),
  });
}

function validateInput(input) {
  if (!exactKeys(input, ['commit']) || !COMMIT_PATTERN.test(input.commit)) {
    fail('INVALID_INPUT');
  }
  return input.commit;
}

export function createSourceClient(config) {
  return Object.freeze({
    async bundle(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const commit = validateInput(args[0]);
      const url = new URL(config.serviceOrigin);
      url.pathname = `${SOURCE_ROUTE_PREFIX}${commit}/reya-network`;

      const bytes = await boundedRequest({
        accept: 'application/json',
        deadlineMs: config.sourceDeadlineMs,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_READ_LIMITS.sourceBytes,
        method: 'GET',
        responseMediaType: 'application/json',
        url: url.href,
      });
      return validateBundle(parseJson(bytes), commit);
    },
  });
}
