export const PREVIEW_PROTOCOL_VERSION = 1;

export const PREVIEW_OPERATIONS = Object.freeze([
  'artifactCat',
  'rpcRead',
  'sourceBundle',
]);

export const PREVIEW_RPC_METHODS = Object.freeze([
  'eth_blockNumber',
  'eth_call',
  'eth_chainId',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'net_version',
]);

export const PREVIEW_BROKER_LIMITS = Object.freeze({
  artifactBytes: 50 * 1024 * 1024,
  concurrentRequests: 4,
  inputBytes: 512 * 1024,
  inputDepth: 12,
  inputNodes: 10_000,
  requestCount: 2_048,
  requestTimeoutMs: 15_000,
  resultBytes: 64 * 1024 * 1024,
  resultDepth: 20,
  resultNodes: 250_000,
  rpcResultBytes: 4 * 1024 * 1024,
  sourceResultBytes: 8 * 1024 * 1024,
});

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TEXT_ENCODER = new TextEncoder();
const REQUEST_KEYS = Object.freeze([
  'id',
  'input',
  'operation',
  'runId',
  'type',
  'version',
]);
const RPC_INPUT_KEYS = Object.freeze(['method', 'params']);

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

function byteLength(value) {
  return TEXT_ENCODER.encode(value).byteLength;
}

function validateJsonValue(
  value,
  { maxDepth, maxNodes },
  state,
  depth = 0
) {
  state.nodes += 1;
  if (state.nodes > maxNodes || depth > maxDepth) {
    throw new Error('preview broker JSON exceeds structural limits');
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === 'string') {
    return;
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== value.length + 1 ||
      !keys.every(
        (key, index) =>
          key === 'length' ||
          (typeof key === 'string' &&
            Number.isSafeInteger(Number(key)) &&
            Number(key) === index)
      )
    ) {
      throw new Error('preview broker JSON contains a sparse or extended array');
    }
    for (const item of value) {
      validateJsonValue(
        item,
        { maxDepth, maxNodes },
        state,
        depth + 1
      );
    }
    return;
  }
  if (!isPlainObject(value)) {
    throw new Error('preview broker input contains a non-JSON value');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
      throw new Error('preview broker input contains a forbidden key');
    }
    validateJsonValue(
      value[key],
      { maxDepth, maxNodes },
      state,
      depth + 1
    );
  }
}

function jsonByteLength(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') {
    throw new Error('preview broker value is not serializable');
  }
  return byteLength(encoded);
}

function validateInput(operation, input, expectedCommit, limits) {
  if (operation === 'sourceBundle') {
    if (
      !exactKeys(input, ['commit']) ||
      !COMMIT_PATTERN.test(input.commit) ||
      input.commit !== expectedCommit
    ) {
      throw new Error('preview source request is not bound to the selected commit');
    }
    return Object.freeze({ commit: input.commit });
  }
  if (operation === 'artifactCat') {
    if (!exactKeys(input, ['cid']) || !CID_V0_PATTERN.test(input.cid)) {
      throw new Error('preview artifact request is invalid');
    }
    return Object.freeze({ cid: input.cid });
  }
  if (operation === 'rpcRead') {
    if (
      !exactKeys(input, RPC_INPUT_KEYS) ||
      !PREVIEW_RPC_METHODS.includes(input.method) ||
      !Array.isArray(input.params)
    ) {
      throw new Error('preview RPC request is outside the read-only contract');
    }
    validateJsonValue(
      input.params,
      {
        maxDepth: limits.inputDepth,
        maxNodes: limits.inputNodes,
      },
      { nodes: 0 }
    );
    if (jsonByteLength(input.params) > limits.inputBytes) {
      throw new Error('preview broker input exceeds byte limits');
    }
    return Object.freeze({
      method: input.method,
      params: structuredClone(input.params),
    });
  }
  throw new Error('preview broker operation is unsupported');
}

/**
 * Validates a preview run identifier generated by the trusted main document.
 *
 * @param {unknown} runId
 * @returns {string}
 */
export function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    throw new Error('preview run ID is invalid');
  }
  return runId;
}

/**
 * Decodes one strictly ordered request from the disposable preview worker.
 *
 * @param {unknown} value
 * @param {{
 *   expectedCommit: string,
 *   expectedId: number,
 *   limits: typeof PREVIEW_BROKER_LIMITS,
 *   runId: string,
 * }} context
 * @returns {{id: number, input: object, operation: string}}
 */
export function decodePreviewRequest(
  value,
  { expectedCommit, expectedId, limits, runId }
) {
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.version !== PREVIEW_PROTOCOL_VERSION ||
    value.type !== 'request' ||
    value.runId !== runId ||
    value.id !== expectedId ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !PREVIEW_OPERATIONS.includes(value.operation)
  ) {
    throw new Error('preview broker request framing is invalid');
  }
  return Object.freeze({
    id: value.id,
    input: validateInput(value.operation, value.input, expectedCommit, limits),
    operation: value.operation,
  });
}

/**
 * Clones a handler result into the narrow data contract posted to the worker.
 *
 * @param {string} operation
 * @param {unknown} result
 * @param {typeof PREVIEW_BROKER_LIMITS} limits
 * @returns {{bytes: number, value: unknown}}
 */
export function preparePreviewResult(operation, result, limits) {
  if (operation === 'artifactCat') {
    if (!(result instanceof Uint8Array)) {
      throw new Error('preview artifact result is invalid');
    }
    const value = new Uint8Array(result);
    return Object.freeze({ bytes: value.byteLength, value });
  }
  validateJsonValue(
    result,
    {
      maxDepth: limits.resultDepth,
      maxNodes: limits.resultNodes,
    },
    { nodes: 0 }
  );
  let encoded;
  try {
    encoded = JSON.stringify(result);
  } catch {
    throw new Error('preview broker result is not serializable');
  }
  if (typeof encoded !== 'string') {
    throw new Error('preview broker result is invalid');
  }
  return Object.freeze({
    bytes: byteLength(encoded),
    value: JSON.parse(encoded),
  });
}
