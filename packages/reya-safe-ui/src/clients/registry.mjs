import { REYA_READ_LIMITS } from './config.mjs';
import { fail } from './errors.mjs';
import {
  boundedRequest,
  parseJson,
  validateRequestContext,
} from './transport.mjs';

export const OP_REGISTRY_RESOLVE_PATH = '/registry/op/resolve';
export const REYA_OMNIBUS_LATEST = 'reya-omnibus:latest@main';

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const PACKAGE_REF_PATTERN =
  /^reya-omnibus:(latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?)@main$/;
const REQUEST_KEYS = Object.freeze(['chainId', 'packageRef']);
const RESPONSE_KEYS = Object.freeze([
  'chainId',
  'cid',
  'deployUrl',
  'found',
  'mutability',
  'packageRef',
  'registryAddress',
  'registryChainId',
  'schemaVersion',
]);
const TEXT_ENCODER = new TextEncoder();

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
    keys.every(
      (key) =>
        typeof key === 'string' &&
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
        expected.includes(key)
    )
  );
}

function canonicalRequest(value) {
  const packageMatch =
    typeof value?.packageRef === 'string'
      ? PACKAGE_REF_PATTERN.exec(value.packageRef)
      : null;
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.chainId !== 1729 ||
    packageMatch === null ||
    packageMatch[1].length > 32
  ) {
    fail('INVALID_INPUT');
  }
  return Object.freeze({
    chainId: 1729,
    packageRef: value.packageRef,
  });
}

function canonicalResponse(value, request) {
  if (
    !exactKeys(value, RESPONSE_KEYS) ||
    value.schemaVersion !== 1 ||
    value.chainId !== 1729 ||
    value.registryChainId !== 10 ||
    value.registryAddress !== '0x8e5c7efc9636a6a0408a46bb7f617094b81e5dba' ||
    value.packageRef !== request.packageRef ||
    typeof value.found !== 'boolean'
  ) {
    fail('RESPONSE_REJECTED');
  }
  if (!value.found) {
    if (
      value.cid !== null ||
      value.deployUrl !== null ||
      value.mutability !== null
    ) {
      fail('RESPONSE_REJECTED');
    }
    fail('OP_ALIAS_UNKNOWN');
  }
  if (
    typeof value.cid !== 'string' ||
    !CID_PATTERN.test(value.cid) ||
    value.deployUrl !== `ipfs://${value.cid}` ||
    (value.mutability !== 'tag' &&
      value.mutability !== 'version' &&
      value.mutability !== '')
  ) {
    fail('RESPONSE_REJECTED');
  }
  return Object.freeze({
    chainId: 1729,
    cid: value.cid,
    deployUrl: value.deployUrl,
    mutability: value.mutability,
    packageRef: value.packageRef,
    registryAddress: value.registryAddress,
    registryChainId: 10,
  });
}

export function isReyaOmnibusPackageRef(value) {
  if (typeof value !== 'string') return false;
  const match = PACKAGE_REF_PATTERN.exec(value);
  return match !== null && match[1].length <= 32;
}

export function createOpRegistryClient(config) {
  return Object.freeze({
    async resolve(...args) {
      if (args.length < 1 || args.length > 2) fail('INVALID_INPUT');
      const request = canonicalRequest(args[0]);
      const externalSignal = validateRequestContext(args[1]);
      const body = JSON.stringify(request);
      if (
        TEXT_ENCODER.encode(body).byteLength >
        REYA_READ_LIMITS.registryRequestBytes
      ) {
        fail('INVALID_INPUT');
      }
      const url = new URL(config.serviceOrigin);
      url.pathname = OP_REGISTRY_RESOLVE_PATH;
      const bytes = await boundedRequest({
        accept: 'application/json',
        body,
        contentType: 'application/json',
        deadlineMs: config.registryDeadlineMs,
        externalSignal,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_READ_LIMITS.registryResponseBytes,
        method: 'POST',
        responseMediaType: 'application/json',
        url: url.href,
      });
      const response = parseJson(bytes);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (JSON.stringify(response) !== text) fail('RESPONSE_REJECTED');
      return canonicalResponse(response, request);
    },
  });
}
