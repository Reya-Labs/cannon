import { fail } from './errors.mjs';

const INPUT_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const RESPONSE_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const INPUT_DATA_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const RESPONSE_DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CALLDATA_BYTES = 512 * 1024;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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

function exactTransaction(value, reject) {
  if (!isPlainObject(value)) reject();
  const keys = Reflect.ownKeys(value);
  if (
    TRANSACTION_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    keys.length !== TRANSACTION_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        FORBIDDEN_KEYS.has(key) ||
        !TRANSACTION_KEYS.includes(key)
    )
  ) {
    reject();
  }
  return value;
}

function dataProperty(value, key, reject) {
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

function assertString(value, maximum, pattern, reject) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !pattern.test(value)
  ) {
    reject();
  }
  return value;
}

function assertInteger(value, reject) {
  if (!Number.isSafeInteger(value) || value < 0) reject();
  return value;
}

function assertUint(value, reject) {
  assertString(value, 78, UINT_PATTERN, reject);
  if (BigInt(value) > MAX_UINT256) reject();
  return value;
}

function inputAddress(value, allowZero, reject = rejectInput) {
  assertString(value, 42, INPUT_ADDRESS_PATTERN, reject);
  if (!allowZero && value === ZERO_ADDRESS) reject();
  return value;
}

function responseAddress(value) {
  return assertString(
    value,
    42,
    RESPONSE_ADDRESS_PATTERN,
    rejectResponse
  ).toLowerCase();
}

function inputData(value) {
  return assertString(
    value,
    2 + MAX_CALLDATA_BYTES * 2,
    INPUT_DATA_PATTERN,
    rejectInput
  );
}

function responseData(value) {
  return assertString(
    value,
    2 + MAX_CALLDATA_BYTES * 2,
    RESPONSE_DATA_PATTERN,
    rejectResponse
  ).toLowerCase();
}

function snapshotTransaction(value, response) {
  const reject = response ? rejectResponse : rejectInput;
  const record = exactTransaction(value, reject);
  const operation = dataProperty(record, 'operation', reject);
  if (operation !== '0' && operation !== '1') reject();

  return Object.freeze({
    _nonce: assertInteger(dataProperty(record, '_nonce', reject), reject),
    baseGas: assertUint(dataProperty(record, 'baseGas', reject), reject),
    data: response
      ? responseData(dataProperty(record, 'data', reject))
      : inputData(dataProperty(record, 'data', reject)),
    gasPrice: assertUint(dataProperty(record, 'gasPrice', reject), reject),
    gasToken: response
      ? responseAddress(dataProperty(record, 'gasToken', reject))
      : inputAddress(dataProperty(record, 'gasToken', reject), true),
    operation,
    refundReceiver: response
      ? responseAddress(dataProperty(record, 'refundReceiver', reject))
      : inputAddress(dataProperty(record, 'refundReceiver', reject), true),
    safeTxGas: assertUint(
      dataProperty(record, 'safeTxGas', reject),
      reject
    ),
    to: response
      ? responseAddress(dataProperty(record, 'to', reject))
      : inputAddress(dataProperty(record, 'to', reject), true),
    value: assertUint(dataProperty(record, 'value', reject), reject),
  });
}

export function snapshotSafeAddress(value) {
  return inputAddress(value, false);
}

export function snapshotSafeTransaction(value) {
  return snapshotTransaction(value, false);
}

export function snapshotSafeTransactionResponse(value) {
  return snapshotTransaction(value, true);
}
