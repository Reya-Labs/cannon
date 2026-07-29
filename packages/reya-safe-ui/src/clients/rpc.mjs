import { PREVIEW_RPC_METHODS } from '../runtime/protocol.mjs';
import { REYA_READ_LIMITS } from './config.mjs';
import { fail } from './errors.mjs';
import {
  boundedRequest,
  parseJson,
  validateRequestContext,
} from './transport.mjs';

export const RPC_ROUTE_PATH = '/rpc/1729';

const INPUT_KEYS = Object.freeze(['method', 'params']);
const RESPONSE_KEYS = Object.freeze(['id', 'jsonrpc', 'result']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TEXT_ENCODER = new TextEncoder();

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
    keys.every(
      (key) =>
        typeof key === 'string' &&
        !FORBIDDEN_KEYS.has(key) &&
        expected.includes(key)
    )
  );
}

function dataProperty(value, key, code, enumerable = true) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== enumerable
  ) {
    fail(code);
  }
  return descriptor.value;
}

function cloneJson(value, state, code, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 250_000 || depth > 20) fail(code);
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const length = dataProperty(value, 'length', code, false);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      keys.length !== length + 1 ||
      !keys.every(
        (key, index) =>
          key === 'length' ||
          (typeof key === 'string' &&
            Number.isSafeInteger(Number(key)) &&
            Number(key) === index)
      )
    ) {
      fail(code);
    }
    return Array.from({ length }, (_, index) =>
      cloneJson(
        dataProperty(value, String(index), code),
        state,
        code,
        depth + 1
      )
    );
  }
  if (!isPlainObject(value)) fail(code);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
      fail(code);
    }
    result[key] = cloneJson(
      dataProperty(value, key, code),
      state,
      code,
      depth + 1
    );
  }
  return result;
}

function freezeJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) freezeJson(item);
    return Object.freeze(value);
  }
  return value;
}

function requestBody(input, id) {
  try {
    if (!exactKeys(input, INPUT_KEYS)) fail('INVALID_INPUT');
    const method = dataProperty(input, 'method', 'INVALID_INPUT');
    const params = dataProperty(input, 'params', 'INVALID_INPUT');
    if (!PREVIEW_RPC_METHODS.includes(method) || !Array.isArray(params)) {
      fail('INVALID_INPUT');
    }
    const snapshot = cloneJson(params, { nodes: 0 }, 'INVALID_INPUT');
    const body = JSON.stringify({
      id,
      jsonrpc: '2.0',
      method,
      params: snapshot,
    });
    if (
      TEXT_ENCODER.encode(body).byteLength >
      REYA_READ_LIMITS.rpcRequestBytes
    ) {
      fail('INVALID_INPUT');
    }
    return body;
  } catch {
    fail('INVALID_INPUT');
  }
}

function responseResult(bytes, expectedId) {
  const decoded = parseJson(bytes);
  if (
    !exactKeys(decoded, RESPONSE_KEYS) ||
    decoded.id !== expectedId ||
    decoded.jsonrpc !== '2.0'
  ) {
    fail('RESPONSE_REJECTED');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (JSON.stringify(decoded) !== text) fail('RESPONSE_REJECTED');
  const result = cloneJson(
    decoded.result,
    { nodes: 0 },
    'RESPONSE_REJECTED'
  );
  return freezeJson(result);
}

export function createRpcClient(config) {
  let nextId = 1;

  return Object.freeze({
    async read(...args) {
      if (
        args.length < 1 ||
        args.length > 2 ||
        !Number.isSafeInteger(nextId)
      ) {
        fail('INVALID_INPUT');
      }
      const externalSignal = validateRequestContext(args[1]);
      const id = nextId;
      const body = requestBody(args[0], id);
      nextId += 1;
      const url = new URL(config.serviceOrigin);
      url.pathname = RPC_ROUTE_PATH;
      const bytes = await boundedRequest({
        accept: 'application/json',
        body,
        contentType: 'application/json',
        deadlineMs: config.rpcDeadlineMs,
        externalSignal,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_READ_LIMITS.rpcResponseBytes,
        method: 'POST',
        responseMediaType: 'application/json',
        url: url.href,
      });
      return responseResult(bytes, id);
    },
  });
}
