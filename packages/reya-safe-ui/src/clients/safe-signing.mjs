import {
  hashTypedData,
  hexToBytes,
  recoverTypedDataAddress,
  toHex,
} from 'viem';
import { REYA_CHAIN_ID } from './config.mjs';
import { fail, ReyaReadClientError } from './errors.mjs';
import {
  snapshotSafeAddress,
  snapshotSafeTransaction,
} from './safe-transaction.mjs';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONFIG_KEYS = Object.freeze(['safeAddress', 'signTypedData']);
const PREPARE_KEYS = Object.freeze(['txn']);
const SIGN_KEYS = Object.freeze(['ownerAddress', 'prepared']);
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

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

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, code) {
  if (!isPlainObject(value)) fail(code);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        FORBIDDEN_KEYS.has(key) ||
        !expected.includes(key)
    )
  ) {
    fail(code);
  }
  return value;
}

function dataProperty(value, key, code) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) {
    fail(code);
  }
  return descriptor.value;
}

function validateConfig(options) {
  try {
    const record = exactKeys(
      options,
      CONFIG_KEYS,
      'INVALID_CONFIGURATION'
    );
    const safeAddress = snapshotSafeAddress(
      dataProperty(record, 'safeAddress', 'INVALID_CONFIGURATION')
    );
    const signTypedData = dataProperty(
      record,
      'signTypedData',
      'INVALID_CONFIGURATION'
    );
    if (typeof signTypedData !== 'function') {
      fail('INVALID_CONFIGURATION');
    }
    return Object.freeze({ safeAddress, signTypedData });
  } catch (error) {
    if (
      error instanceof ReyaReadClientError &&
      error.code === 'INVALID_CONFIGURATION'
    ) {
      throw error;
    }
    fail('INVALID_CONFIGURATION');
  }
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

function normalizeSignature(value) {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) {
    fail('SIGNATURE_REJECTED');
  }
  const bytes = hexToBytes(value);
  const recovery = bytes[64];
  if (recovery === 0 || recovery === 1) {
    bytes[64] = recovery + 27;
  } else if (recovery !== 27 && recovery !== 28) {
    fail('SIGNATURE_REJECTED');
  }
  return toHex(bytes);
}

export function createReyaSafeSigningClient(options) {
  const config = validateConfig(options);
  const preparedValues = new WeakSet();
  let signing = false;

  return Object.freeze({
    chainId: REYA_CHAIN_ID,
    prepare(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const input = exactKeys(args[0], PREPARE_KEYS, 'INVALID_INPUT');
      const txn = snapshotSafeTransaction(
        dataProperty(input, 'txn', 'INVALID_INPUT')
      );
      const value = typedData(config.safeAddress, txn);
      let safeTxHash;
      try {
        safeTxHash = hashTypedData(value);
      } catch {
        fail('INVALID_INPUT');
      }
      const prepared = Object.freeze({
        safeTxHash,
        txn,
        typedData: value,
      });
      preparedValues.add(prepared);
      return prepared;
    },
    safeAddress: config.safeAddress,
    async sign(...args) {
      if (args.length !== 1) fail('INVALID_INPUT');
      const input = exactKeys(args[0], SIGN_KEYS, 'INVALID_INPUT');
      const ownerAddress = snapshotSafeAddress(
        dataProperty(input, 'ownerAddress', 'INVALID_INPUT')
      );
      const prepared = dataProperty(
        input,
        'prepared',
        'INVALID_INPUT'
      );
      if (!preparedValues.has(prepared)) fail('INVALID_INPUT');
      if (signing) fail('SIGNING_IN_PROGRESS');
      signing = true;

      try {
        let walletSignature;
        try {
          walletSignature = await config.signTypedData(
            Object.freeze({
              account: ownerAddress,
              ...prepared.typedData,
            })
          );
        } catch {
          fail('WALLET_REQUEST_FAILED');
        }

        const signature = normalizeSignature(walletSignature);
        let recovered;
        try {
          recovered = await recoverTypedDataAddress({
            ...prepared.typedData,
            signature,
          });
        } catch {
          fail('SIGNATURE_REJECTED');
        }
        if (recovered.toLowerCase() !== ownerAddress) {
          fail('SIGNATURE_REJECTED');
        }

        return Object.freeze({
          safeTxHash: prepared.safeTxHash,
          signature,
          signer: ownerAddress,
        });
      } finally {
        signing = false;
      }
    },
  });
}
