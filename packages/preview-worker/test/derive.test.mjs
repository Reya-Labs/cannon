import assert from 'node:assert/strict';
import test from 'node:test';
import { hashTypedData, zeroAddress } from 'viem';
import {
  deriveSafeTransaction,
  MULTICALL_ADDRESS,
  SAFE_TX_TYPES,
} from '../src/derive.mjs';
import { SAFE_ADDRESS } from './support.mjs';

const TARGET = '0x00000000000000000000000000000000000000aa';

function call(overrides = {}) {
  return {
    data: '0xabcdef01',
    decoded: null,
    from: SAFE_ADDRESS,
    gasUsed: '21000',
    senderRole: 'safe',
    sequence: 0,
    step: 'invoke.upgrade',
    to: TARGET,
    transactionHash: `0x${'1'.repeat(64)}`,
    value: '0',
    ...overrides,
  };
}

function simulation(overrides = {}) {
  return {
    deployerPrerequisites: [],
    safeAddress: SAFE_ADDRESS,
    safeProposalCalls: [call()],
    ...overrides,
  };
}

test('derives one multicall delegatecall at the observed nonce', () => {
  const { safeTxHash, txn } = deriveSafeTransaction(simulation(), 42);
  assert.equal(txn._nonce, 42);
  assert.equal(txn.to, MULTICALL_ADDRESS);
  assert.equal(txn.operation, '1');
  assert.equal(txn.baseGas, '0');
  assert.equal(txn.gasPrice, '0');
  assert.equal(txn.gasToken, zeroAddress);
  assert.equal(txn.refundReceiver, SAFE_ADDRESS);
  assert.equal(txn.safeTxGas, '21000');
  assert.equal(txn.value, '0');
  assert.match(safeTxHash, /^0x[0-9a-f]{64}$/);
});

test('the digest is the Safe EIP-712 hash of the derived transaction', () => {
  const { safeTxHash, txn } = deriveSafeTransaction(simulation(), 7);
  assert.equal(
    safeTxHash,
    hashTypedData({
      domain: { chainId: 1729, verifyingContract: SAFE_ADDRESS },
      message: {
        baseGas: 0n,
        data: txn.data,
        gasPrice: 0n,
        gasToken: zeroAddress,
        nonce: 7n,
        operation: 1,
        refundReceiver: SAFE_ADDRESS,
        safeTxGas: 21000n,
        to: MULTICALL_ADDRESS,
        value: 0n,
      },
      primaryType: 'SafeTx',
      types: { SafeTx: SAFE_TX_TYPES },
    }),
  );
});

test('the nonce changes the digest, so a stale nonce cannot be reused', () => {
  const first = deriveSafeTransaction(simulation(), 1);
  const second = deriveSafeTransaction(simulation(), 2);
  assert.notEqual(first.safeTxHash, second.safeTxHash);
});

test('the call set changes the digest', () => {
  const first = deriveSafeTransaction(simulation(), 1);
  const second = deriveSafeTransaction(
    simulation({ safeProposalCalls: [call({ data: '0xabcdef02' })] }),
    1,
  );
  assert.notEqual(first.safeTxHash, second.safeTxHash);
});

test('sums value and gas across every Safe call', () => {
  const { txn } = deriveSafeTransaction(
    simulation({
      safeProposalCalls: [
        call({ gasUsed: '1000', value: '5' }),
        call({ gasUsed: '2000', sequence: 1, value: '7' }),
      ],
    }),
    0,
  );
  assert.equal(txn.value, '12');
  assert.equal(txn.safeTxGas, '3000');
});

test('refuses to stage a preview that still needs deployer prerequisites', () => {
  assert.throws(
    () =>
      deriveSafeTransaction(
        simulation({
          deployerPrerequisites: [call({ senderRole: 'deployer' })],
        }),
        0,
      ),
    { code: 'PREVIEW_NOT_STAGEABLE' },
  );
});

test('refuses a call that did not originate from the Safe', () => {
  assert.throws(
    () =>
      deriveSafeTransaction(
        simulation({
          safeProposalCalls: [call({ from: `0x${'b'.repeat(40)}` })],
        }),
        0,
      ),
    { code: 'PREVIEW_NOT_STAGEABLE' },
  );
  assert.throws(
    () =>
      deriveSafeTransaction(
        simulation({ safeProposalCalls: [call({ senderRole: 'deployer' })] }),
        0,
      ),
    { code: 'PREVIEW_NOT_STAGEABLE' },
  );
});

test('refuses a contract-creation call with no target', () => {
  assert.throws(
    () =>
      deriveSafeTransaction(
        simulation({ safeProposalCalls: [call({ to: null })] }),
        0,
      ),
    { code: 'PREVIEW_NOT_STAGEABLE' },
  );
});

test('refuses an empty call set and a negative nonce', () => {
  assert.throws(
    () => deriveSafeTransaction(simulation({ safeProposalCalls: [] }), 0),
    { code: 'PREVIEW_NOT_STAGEABLE' },
  );
  assert.throws(() => deriveSafeTransaction(simulation(), -1), {
    code: 'PREVIEW_NOT_STAGEABLE',
  });
  assert.throws(() => deriveSafeTransaction(simulation(), 1.5), {
    code: 'PREVIEW_NOT_STAGEABLE',
  });
});

test('refuses malformed calldata and non-integer values', () => {
  for (const overrides of [
    { data: '0xabc' },
    { data: 'abcdef01' },
    { value: '-1' },
    { value: '0x10' },
    { gasUsed: '1e3' },
  ]) {
    assert.throws(
      () =>
        deriveSafeTransaction(
          simulation({ safeProposalCalls: [call(overrides)] }),
          0,
        ),
      { code: 'PREVIEW_NOT_STAGEABLE' },
      JSON.stringify(overrides),
    );
  }
});
