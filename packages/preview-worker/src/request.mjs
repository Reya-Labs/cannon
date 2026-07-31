import { PreviewError } from './errors.mjs';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const PACKAGE_REF_PATTERN =
  /^reya-omnibus:(?:latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?)@main$/;

/**
 * The preview request is deliberately tiny. It names immutable inputs only; it
 * can never carry calls, a Safe transaction, a nonce, a hash or any other value
 * the worker is responsible for deriving.
 */
export const PREVIEW_REQUEST_KEYS = Object.freeze([
  'chainId',
  'commit',
  'partialDeployCid',
  'previousPackageCid',
  'safeAddress',
]);

export const REGISTRY_REQUEST_KEYS = Object.freeze(['chainId', 'packageRef']);

export const MAX_PREVIEW_REQUEST_BYTES = 1_024;
export const MAX_REGISTRY_REQUEST_BYTES = 512;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function reject() {
  throw new PreviewError(400, 'INVALID_REQUEST');
}

/**
 * Parses one exact JSON document.
 *
 * The re-serialisation check pins key order and rejects duplicate keys,
 * additional whitespace and prototype-polluting members, so there is exactly
 * one byte sequence that can express a given request.
 */
function exactDocument(encoded, keys, maximumBytes) {
  if (
    typeof encoded !== 'string' ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, 'utf8') > maximumBytes
  ) {
    reject();
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    reject();
  }
  if (
    !isPlainObject(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(keys) ||
    JSON.stringify(value) !== encoded
  ) {
    reject();
  }
  return value;
}

/**
 * Validates one production preview request against the immutable deployment
 * binding. A browser-supplied preview document, call list, Safe transaction or
 * `safeTxHash` cannot pass this function: those keys are not in the contract,
 * and the exact-key check rejects the whole request if they appear.
 *
 * @param {string} encoded
 * @param {{chainId: number, safeAddress: string}} expected
 */
export function parsePreviewRequest(encoded, expected) {
  const value = exactDocument(
    encoded,
    PREVIEW_REQUEST_KEYS,
    MAX_PREVIEW_REQUEST_BYTES,
  );
  if (
    value.chainId !== expected.chainId ||
    typeof value.commit !== 'string' ||
    !COMMIT_PATTERN.test(value.commit) ||
    (value.partialDeployCid !== null &&
      (typeof value.partialDeployCid !== 'string' ||
        !CID_PATTERN.test(value.partialDeployCid))) ||
    typeof value.previousPackageCid !== 'string' ||
    !CID_PATTERN.test(value.previousPackageCid) ||
    typeof value.safeAddress !== 'string' ||
    !ADDRESS_PATTERN.test(value.safeAddress) ||
    value.safeAddress !== expected.safeAddress
  ) {
    reject();
  }
  if (value.partialDeployCid === value.previousPackageCid) {
    reject();
  }
  return Object.freeze({
    chainId: value.chainId,
    commit: value.commit,
    deploymentMode: value.partialDeployCid === null ? 'cannonfile' : 'partial',
    partialDeployCid: value.partialDeployCid,
    previousPackageCid: value.previousPackageCid,
    safeAddress: value.safeAddress,
  });
}

/**
 * Validates one OP registry alias resolution request. Only the exact
 * `reya-omnibus:<version|latest>@main` alias family is resolvable; the OP
 * registry is a package-reference lookup and never a build or storage input.
 *
 * @param {string} encoded
 * @param {{chainId: number}} expected
 */
export function parseRegistryRequest(encoded, expected) {
  const value = exactDocument(
    encoded,
    REGISTRY_REQUEST_KEYS,
    MAX_REGISTRY_REQUEST_BYTES,
  );
  if (
    value.chainId !== expected.chainId ||
    typeof value.packageRef !== 'string' ||
    value.packageRef.length > 128 ||
    !PACKAGE_REF_PATTERN.test(value.packageRef)
  ) {
    reject();
  }
  return Object.freeze({
    chainId: value.chainId,
    packageRef: value.packageRef,
  });
}
