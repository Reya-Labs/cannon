import { hashTypedData } from 'viem';
import { REYA_CHAIN_ID } from './config.mjs';
import { fail } from './errors.mjs';
import {
  snapshotSafeAddress,
  snapshotSafeTransaction,
} from './safe-transaction.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INPUT_KEYS = Object.freeze(['safeAddress', 'txn']);

export const SAFE_TX_TYPES = Object.freeze([
  Object.freeze({ name: 'to', type: 'address' }),
  Object.freeze({ name: 'value', type: 'uint256' }),
  Object.freeze({ name: 'data', type: 'bytes' }),
  Object.freeze({ name: 'operation', type: 'uint8' }),
  Object.freeze({ name: 'safeTxGas', type: 'uint256' }),
  Object.freeze({ name: 'baseGas', type: 'uint256' }),
  Object.freeze({ name: 'gasPrice', type: 'uint256' }),
  Object.freeze({ name: 'gasToken', type: 'address' }),
  Object.freeze({ name: 'refundReceiver', type: 'address' }),
  Object.freeze({ name: 'nonce', type: 'uint256' }),
]);

function exactInput(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    fail('INVALID_INPUT');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== INPUT_KEYS.length ||
    INPUT_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        FORBIDDEN_KEYS.has(key) ||
        !INPUT_KEYS.includes(key)
    )
  ) {
    fail('INVALID_INPUT');
  }
  return value;
}

function dataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) {
    fail('INVALID_INPUT');
  }
  return descriptor.value;
}

function typedData(safeAddress, txn) {
  return Object.freeze({
    domain: Object.freeze({
      chainId: REYA_CHAIN_ID,
      verifyingContract: safeAddress,
    }),
    message: Object.freeze({
      baseGas: BigInt(txn.baseGas),
      data: txn.data,
      gasPrice: BigInt(txn.gasPrice),
      gasToken: txn.gasToken,
      nonce: BigInt(txn._nonce),
      operation: Number(txn.operation),
      refundReceiver: txn.refundReceiver,
      safeTxGas: BigInt(txn.safeTxGas),
      to: txn.to,
      value: BigInt(txn.value),
    }),
    primaryType: 'SafeTx',
    types: Object.freeze({ SafeTx: SAFE_TX_TYPES }),
  });
}

/**
 * Validates one Reya Safe transaction and derives its review-only EIP-712 hash.
 * This module has no wallet callback, signing method, staging transport or
 * mutation capability.
 */
export function prepareReyaSafeTransaction(...args) {
  if (args.length !== 1) fail('INVALID_INPUT');
  const input = exactInput(args[0]);
  const safeAddress = snapshotSafeAddress(dataProperty(input, 'safeAddress'));
  const txn = snapshotSafeTransaction(dataProperty(input, 'txn'));
  const value = typedData(safeAddress, txn);
  let safeTxHash;
  try {
    safeTxHash = hashTypedData(value);
  } catch {
    fail('INVALID_INPUT');
  }
  return Object.freeze({
    safeTxHash,
    txn,
    typedData: value,
  });
}
