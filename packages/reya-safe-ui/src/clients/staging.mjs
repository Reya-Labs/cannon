import {
  REYA_CHAIN_ID,
  validateServiceOrigin,
} from './config.mjs';
import {
  fail,
  failStagingService,
} from './errors.mjs';
import {
  boundedStagingRequest,
  parseJson,
  validateRequestContext,
} from './transport.mjs';

export const STAGING_ROUTE_PREFIX = '/staging';

export const REYA_STAGING_LIMITS = Object.freeze({
  deadlineMs: 12_000,
  requestBytes: 1024 * 1024,
  responseBytes: 1200 * 1024,
});

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const RESPONSE_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DATA_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const RESPONSE_DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-f]{128}(?:1b|1c)$/;
const RESPONSE_SIGNATURE_PATTERN =
  /^0x[0-9a-fA-F]{128}(?:1[bB]|1[cC])$/;
const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CALLDATA_BYTES = 512 * 1024;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STAGE_KEYS = Object.freeze(['signature', 'txn']);
const SUPERSEDE_KEYS = Object.freeze([
  'expectedDigest',
  'idempotencyKey',
  'reason',
]);
const TRANSACTION_KEYS = Object.freeze([
  '_nonce',
  'baseGas',
  'data',
  'gasPrice',
  'gasToken',
  'operation',
  'refundReceiver',
  'safeTxGas',
  'to',
  'value',
]);
const PROPOSAL_KEYS = Object.freeze([
  'createdAt',
  'sigs',
  'txn',
  'updatedAt',
]);
const SUPERSEDE_RESPONSE_KEYS = Object.freeze(['digest', 'status']);
const ERROR_KEYS = Object.freeze(['code', 'message']);
const OPTIONAL_ERROR_KEYS = Object.freeze(['details']);
const SERVICE_ERROR_CODES = new Map([
  [
    400,
    new Set([
      'invalid_chain',
      'invalid_idempotency_key',
      'invalid_json',
      'invalid_request',
      'invalid_safe',
      'invalid_signature',
      'non_owner_signature',
      'unsupported_signature_type',
    ]),
  ],
  [401, new Set(['unauthenticated'])],
  [
    403,
    new Set([
      'forbidden',
      'invalid_role',
      'origin_forbidden',
      'proposer_role_required',
    ]),
  ],
  [
    404,
    new Set([
      'not_found',
      'proposal_not_found',
      'safe_not_allowed',
    ]),
  ],
  [
    409,
    new Set([
      'duplicate_owner_signature',
      'idempotency_conflict',
      'nonce_conflict',
      'owner_signature_conflict',
      'proposal_expired',
      'proposal_state_changed',
      'proposal_tombstoned',
      'safe_nonce_advanced',
      'safe_nonce_changed',
      'stale_or_future_nonce',
      'supersede_conflict',
    ]),
  ],
  [413, new Set(['body_too_large'])],
  [429, new Set(['proposal_quota_exceeded', 'rate_limited'])],
  [500, new Set(['internal_error'])],
  [
    503,
    new Set([
      'not_ready',
      'persistence_corrupt',
      'persistence_protocol_error',
      'persistence_unavailable',
      'rpc_unavailable',
      'safe_nonce_unsupported',
    ]),
  ],
]);

function rejectInput() {
  fail('INVALID_INPUT');
}

function rejectResponse() {
  fail('RESPONSE_REJECTED');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = [], reject = rejectResponse) {
  if (!isPlainObject(value)) reject();
  const keys = Reflect.ownKeys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        FORBIDDEN_KEYS.has(key) ||
        (!required.includes(key) && !optional.includes(key))
    )
  ) {
    reject();
  }
  return value;
}

function dataProperty(value, key, reject = rejectResponse) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) {
    reject();
  }
  return descriptor.value;
}

function assertString(value, maximum, pattern, reject = rejectResponse) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    reject();
  }
  return value;
}

function assertInteger(value, reject = rejectResponse) {
  if (!Number.isSafeInteger(value) || value < 0) reject();
  return value;
}

function assertUint(value, reject = rejectResponse) {
  assertString(value, 78, UINT_PATTERN, reject);
  if (BigInt(value) > MAX_UINT256) reject();
  return value;
}

function assertInputAddress(value, allowZero = true) {
  assertString(value, 42, ADDRESS_PATTERN, rejectInput);
  if (!allowZero && value === ZERO_ADDRESS) rejectInput();
  return value;
}

function assertResponseAddress(value) {
  return assertString(
    value,
    42,
    RESPONSE_ADDRESS_PATTERN
  ).toLowerCase();
}

function assertInputData(value) {
  assertString(
    value,
    2 + MAX_CALLDATA_BYTES * 2,
    DATA_PATTERN,
    rejectInput
  );
  return value;
}

function assertResponseData(value) {
  return assertString(
    value,
    2 + MAX_CALLDATA_BYTES * 2,
    RESPONSE_DATA_PATTERN
  ).toLowerCase();
}

function assertInputSignature(value) {
  return assertString(value, 132, SIGNATURE_PATTERN, rejectInput);
}

function assertResponseSignature(value) {
  return assertString(
    value,
    132,
    RESPONSE_SIGNATURE_PATTERN
  ).toLowerCase();
}

function snapshotTransaction(value, reject = rejectInput) {
  const record = exactKeys(value, TRANSACTION_KEYS, [], reject);
  const operation = dataProperty(record, 'operation', reject);
  if (operation !== '0' && operation !== '1') reject();

  return Object.freeze({
    _nonce: assertInteger(dataProperty(record, '_nonce', reject), reject),
    baseGas: assertUint(dataProperty(record, 'baseGas', reject), reject),
    data:
      reject === rejectInput
        ? assertInputData(dataProperty(record, 'data', reject))
        : assertResponseData(dataProperty(record, 'data', reject)),
    gasPrice: assertUint(dataProperty(record, 'gasPrice', reject), reject),
    gasToken:
      reject === rejectInput
        ? assertInputAddress(dataProperty(record, 'gasToken', reject))
        : assertResponseAddress(dataProperty(record, 'gasToken', reject)),
    operation,
    refundReceiver:
      reject === rejectInput
        ? assertInputAddress(dataProperty(record, 'refundReceiver', reject))
        : assertResponseAddress(
            dataProperty(record, 'refundReceiver', reject)
          ),
    safeTxGas: assertUint(
      dataProperty(record, 'safeTxGas', reject),
      reject
    ),
    to:
      reject === rejectInput
        ? assertInputAddress(dataProperty(record, 'to', reject))
        : assertResponseAddress(dataProperty(record, 'to', reject)),
    value: assertUint(dataProperty(record, 'value', reject), reject),
  });
}

function snapshotArray(value, maximum, itemParser) {
  if (!Array.isArray(value)) rejectResponse();
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined ||
    !Object.hasOwn(length, 'value') ||
    length.enumerable !== false ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > maximum ||
    keys.length !== length.value + 1 ||
    !keys.every(
      (key, index) =>
        key === 'length' ||
        (typeof key === 'string' &&
          String(index) === key &&
          index < length.value)
    )
  ) {
    rejectResponse();
  }

  return Object.freeze(
    Array.from({ length: length.value }, (_, index) =>
      itemParser(dataProperty(value, String(index)))
    )
  );
}

function snapshotProposal(value) {
  const record = exactKeys(value, PROPOSAL_KEYS);
  const createdAt = assertInteger(dataProperty(record, 'createdAt'));
  const updatedAt = assertInteger(dataProperty(record, 'updatedAt'));
  if (updatedAt < createdAt) rejectResponse();
  const sigs = snapshotArray(
    dataProperty(record, 'sigs'),
    100,
    assertResponseSignature
  );
  if (new Set(sigs).size !== sigs.length) rejectResponse();

  return Object.freeze({
    createdAt,
    sigs,
    txn: snapshotTransaction(
      dataProperty(record, 'txn'),
      rejectResponse
    ),
    updatedAt,
  });
}

function canonicalJson(bytes) {
  const decoded = parseJson(bytes);
  let text;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    rejectResponse();
  }
  if (JSON.stringify(decoded) !== text) rejectResponse();
  return decoded;
}

function parseProposalEnvelope(bytes) {
  const decoded = canonicalJson(bytes);
  const proposals = snapshotArray(decoded, 1, snapshotProposal);
  return proposals.length === 0 ? null : proposals[0];
}

function parseServiceError(bytes, status) {
  const decoded = canonicalJson(bytes);
  const errorEnvelope = exactKeys(decoded, ['error']);
  const error = exactKeys(
    dataProperty(errorEnvelope, 'error'),
    ERROR_KEYS,
    OPTIONAL_ERROR_KEYS
  );
  const serviceCode = assertString(
    dataProperty(error, 'code'),
    64,
    /^[a-z][a-z0-9_]*$/
  );
  assertString(dataProperty(error, 'message'), 1024);
  if (!SERVICE_ERROR_CODES.get(status)?.has(serviceCode)) {
    rejectResponse();
  }
  failStagingService(status, serviceCode);
}

function parseResponse(response) {
  if (response.status !== 200 && response.status !== 201) {
    parseServiceError(response.bytes, response.status);
  }
  return parseProposalEnvelope(response.bytes);
}

function sameTransaction(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateOptions(options) {
  try {
    const record = exactKeys(
      options,
      ['safeAddress', 'serviceOrigin'],
      ['deadlineMs', 'fetchImpl'],
      () => fail('INVALID_CONFIGURATION')
    );
    const safeAddress = assertInputAddress(
      dataProperty(
        record,
        'safeAddress',
        () => fail('INVALID_CONFIGURATION')
      ),
      false
    );
    const serviceOrigin = validateServiceOrigin(
      dataProperty(
        record,
        'serviceOrigin',
        () => fail('INVALID_CONFIGURATION')
      )
    );
    const fetchImpl = Object.hasOwn(record, 'fetchImpl')
      ? dataProperty(
          record,
          'fetchImpl',
          () => fail('INVALID_CONFIGURATION')
        )
      : globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      fail('INVALID_CONFIGURATION');
    }
    const deadlineMs = Object.hasOwn(record, 'deadlineMs')
      ? dataProperty(
          record,
          'deadlineMs',
          () => fail('INVALID_CONFIGURATION')
        )
      : REYA_STAGING_LIMITS.deadlineMs;
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > REYA_STAGING_LIMITS.deadlineMs
    ) {
      fail('INVALID_CONFIGURATION');
    }
    return Object.freeze({
      deadlineMs,
      fetchImpl,
      safeAddress,
      serviceOrigin,
    });
  } catch (error) {
    if (error?.code === 'INVALID_CONFIGURATION') throw error;
    fail('INVALID_CONFIGURATION');
  }
}

function requestBody(value) {
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    rejectInput();
  }
  if (
    TEXT_ENCODER.encode(body).byteLength >
    REYA_STAGING_LIMITS.requestBytes
  ) {
    rejectInput();
  }
  return body;
}

function routeUrl(config, suffix = '') {
  const url = new URL(config.serviceOrigin);
  url.pathname =
    `${STAGING_ROUTE_PREFIX}/${REYA_CHAIN_ID}/` +
    `${config.safeAddress}${suffix}`;
  return url.href;
}

export function createReyaStagingClient(options) {
  const config = validateOptions(options);

  return Object.freeze({
    chainId: REYA_CHAIN_ID,
    async current(...args) {
      if (args.length > 1) rejectInput();
      const externalSignal = validateRequestContext(args[0]);
      const response = await boundedStagingRequest({
        deadlineMs: config.deadlineMs,
        externalSignal,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_STAGING_LIMITS.responseBytes,
        method: 'GET',
        url: routeUrl(config),
      });
      if (response.status === 201) rejectResponse();
      return parseResponse(response);
    },
    safeAddress: config.safeAddress,
    serviceOrigin: config.serviceOrigin,
    async submitSignature(...args) {
      if (args.length < 1 || args.length > 2) rejectInput();
      const input = exactKeys(
        args[0],
        STAGE_KEYS,
        [],
        rejectInput
      );
      const signature = assertInputSignature(
        dataProperty(input, 'signature', rejectInput)
      );
      const txn = snapshotTransaction(
        dataProperty(input, 'txn', rejectInput)
      );
      const externalSignal = validateRequestContext(args[1]);
      const response = await boundedStagingRequest({
        body: requestBody({ sigs: [signature], txn }),
        deadlineMs: config.deadlineMs,
        externalSignal,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_STAGING_LIMITS.responseBytes,
        method: 'POST',
        url: routeUrl(config),
      });
      const proposal = parseResponse(response);
      if (
        proposal === null ||
        !sameTransaction(proposal.txn, txn) ||
        !proposal.sigs.includes(signature)
      ) {
        rejectResponse();
      }
      return Object.freeze({
        created: response.status === 201,
        proposal,
      });
    },
    async supersede(...args) {
      if (args.length < 1 || args.length > 2) rejectInput();
      const input = exactKeys(
        args[0],
        SUPERSEDE_KEYS,
        [],
        rejectInput
      );
      const expectedDigest = assertString(
        dataProperty(input, 'expectedDigest', rejectInput),
        66,
        DIGEST_PATTERN,
        rejectInput
      );
      const idempotencyKey = assertString(
        dataProperty(input, 'idempotencyKey', rejectInput),
        128,
        /^[a-zA-Z0-9._:-]{16,128}$/,
        rejectInput
      );
      const reasonValue = assertString(
        dataProperty(input, 'reason', rejectInput),
        500,
        undefined,
        rejectInput
      );
      const reason = reasonValue.trim();
      if (reason.length < 8 || reason !== reasonValue) rejectInput();
      const externalSignal = validateRequestContext(args[1]);
      const response = await boundedStagingRequest({
        body: requestBody({ expectedDigest, reason }),
        deadlineMs: config.deadlineMs,
        externalSignal,
        fetchImpl: config.fetchImpl,
        idempotencyKey,
        maximumBytes: REYA_STAGING_LIMITS.responseBytes,
        method: 'POST',
        url: routeUrl(config, '/supersede'),
      });
      if (response.status !== 200) {
        parseServiceError(response.bytes, response.status);
      }
      const decoded = canonicalJson(response.bytes);
      const result = exactKeys(decoded, SUPERSEDE_RESPONSE_KEYS);
      if (
        dataProperty(result, 'digest') !== expectedDigest ||
        dataProperty(result, 'status') !== 'superseded'
      ) {
        rejectResponse();
      }
      return Object.freeze({
        digest: expectedDigest,
        status: 'superseded',
      });
    },
  });
}
