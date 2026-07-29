import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareReyaSafeTransaction,
  ReyaReadClientError,
} from '../src/clients/index.mjs';
import { SAFE_ADDRESS } from '../test-support/client-fixtures.mjs';

const TRANSACTION = Object.freeze({
  _nonce: 7,
  baseGas: '11',
  data: '0x1234',
  gasPrice: '13',
  gasToken: '0x0000000000000000000000000000000000000000',
  operation: '1',
  refundReceiver: SAFE_ADDRESS,
  safeTxGas: '17',
  to: '0x2222222222222222222222222222222222222222',
  value: '19',
});

test('prepares a deeply frozen review payload without a signing method', () => {
  const mutable = { ...TRANSACTION };
  const prepared = prepareReyaSafeTransaction({
    safeAddress: SAFE_ADDRESS,
    txn: mutable,
  });
  mutable.data = '0xdead';

  assert.match(prepared.safeTxHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(prepared.txn, TRANSACTION);
  assert.equal('sign' in prepared, false);
  assert.equal('signTypedData' in prepared, false);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.txn));
  assert.ok(Object.isFrozen(prepared.typedData));
  assert.ok(Object.isFrozen(prepared.typedData.domain));
  assert.ok(Object.isFrozen(prepared.typedData.message));
});

test('rejects extra, missing and accessor-backed review input', () => {
  let reads = 0;
  const accessor = { safeAddress: SAFE_ADDRESS };
  Object.defineProperty(accessor, 'txn', {
    enumerable: true,
    get() {
      reads += 1;
      return TRANSACTION;
    },
  });

  for (const input of [
    { safeAddress: SAFE_ADDRESS },
    { safeAddress: SAFE_ADDRESS, txn: TRANSACTION, wallet: true },
    accessor,
  ]) {
    assert.throws(
      () => prepareReyaSafeTransaction(input),
      (error) =>
        error instanceof ReyaReadClientError && error.code === 'INVALID_INPUT'
    );
  }
  assert.equal(reads, 0);
});
