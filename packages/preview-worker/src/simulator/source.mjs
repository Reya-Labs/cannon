import { createHash } from 'node:crypto';
import { PreviewError } from '../errors.mjs';
import { boundedUpstreamRequest } from './upstream.mjs';

export const SOURCE_REPOSITORY = 'Reya-Labs/reya-deployments';
export const SOURCE_ROOT = 'packages/tomls/src/omnibus/reya_network.toml';
export const SOURCE_ROUTE_PREFIX = '/source/reya-deployments/';
export const SOURCE_ROUTE_SUFFIX = '/reya-network';

// Recorded as Cannon build provenance and compared against a partial
// deployment's own `meta.gitUrl`. It is never fetched: the worker reads source
// only from the cluster-internal gateway.
export const SOURCE_GIT_URL = 'https://github.com/Reya-Labs/reya-deployments';

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const SOURCE_TIMEOUT_MS = 30_000;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FILES = 512;
const BUNDLE_KEYS = Object.freeze([
  'bundleSha256',
  'commit',
  'files',
  'repository',
  'root',
  'schemaVersion',
]);
const FILE_KEYS = Object.freeze(['content', 'path', 'sha256']);

/**
 * A source bundle that does not hash to what it claims is a compromised or
 * corrupted build input, not a transport problem. It fails as a preview
 * failure so it is never confused with an upstream being down.
 */
function reject() {
  throw new PreviewError(502, 'PREVIEW_FAILED');
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
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
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Validates one immutable `reya-deployments` source bundle.
 *
 * Every file is re-hashed, and the canonical bundle is re-hashed as a whole,
 * so a gateway that swapped one TOML byte cannot reach the Cannon definition
 * this preview is derived from. The include closure itself is enforced later by
 * the definition assembler, which rejects cycles, missing includes and
 * unreachable files.
 */
export function validateSourceBundle(value, expectedCommit) {
  if (
    !COMMIT_PATTERN.test(expectedCommit) ||
    !exactKeys(value, BUNDLE_KEYS) ||
    value.schemaVersion !== 1 ||
    value.repository !== SOURCE_REPOSITORY ||
    value.commit !== expectedCommit ||
    value.root !== SOURCE_ROOT ||
    typeof value.bundleSha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.bundleSha256) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > MAX_FILES
  ) {
    reject();
  }

  const files = [];
  let previousPath = '';
  let hasRoot = false;
  for (const candidate of value.files) {
    if (
      !exactKeys(candidate, FILE_KEYS) ||
      !validSourcePath(candidate.path) ||
      typeof candidate.content !== 'string' ||
      typeof candidate.sha256 !== 'string' ||
      !DIGEST_PATTERN.test(candidate.sha256) ||
      candidate.path <= previousPath ||
      sha256(candidate.content) !== candidate.sha256
    ) {
      reject();
    }
    previousPath = candidate.path;
    hasRoot ||= candidate.path === SOURCE_ROOT;
    files.push(
      Object.freeze({
        content: candidate.content,
        path: candidate.path,
        sha256: candidate.sha256,
      }),
    );
  }
  if (!hasRoot) reject();

  const canonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: expectedCommit,
    root: SOURCE_ROOT,
    files,
  };
  if (sha256(JSON.stringify(canonical)) !== value.bundleSha256) reject();

  return Object.freeze({
    bundleSha256: value.bundleSha256,
    commit: expectedCommit,
    files: Object.freeze(files),
    repository: SOURCE_REPOSITORY,
    root: SOURCE_ROOT,
    schemaVersion: 1,
  });
}

/**
 * Reads pinned `reya-deployments` source from the cluster-internal gateway.
 *
 * The commit is the only variable in the URL and it is already validated to be
 * a lowercase 40-character SHA, so there is no branch, tag, path or repository
 * a caller could steer.
 *
 * @param {{fetchImpl?: typeof fetch, origin: string}} options
 */
export function createSourceBundleReader({ fetchImpl, origin }) {
  if (typeof origin !== 'string' || origin.length < 1) {
    throw new Error('preview source reader configuration is invalid');
  }
  return Object.freeze({
    async bundle({ commit, signal }) {
      if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
        throw new Error('preview source commit is invalid');
      }
      const bytes = await boundedUpstreamRequest({
        accept: 'application/json',
        fetchImpl,
        maximumBytes: MAX_SOURCE_BYTES,
        method: 'GET',
        signal,
        timeoutMs: SOURCE_TIMEOUT_MS,
        url: `${origin}${SOURCE_ROUTE_PREFIX}${commit}${SOURCE_ROUTE_SUFFIX}`,
      });
      let parsed;
      try {
        parsed = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch {
        reject();
      }
      return validateSourceBundle(parsed, commit);
    },
  });
}
