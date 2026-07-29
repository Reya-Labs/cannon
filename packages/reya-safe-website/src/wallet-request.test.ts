import { describe, expect, it } from 'vitest';
import { walletTypedData } from './wallet-request';

const OWNER = '0x1111111111111111111111111111111111111111';
const SAFE = '0x2222222222222222222222222222222222222222';

function request() {
  return {
    account: OWNER,
    domain: {
      chainId: 1729,
      verifyingContract: SAFE,
    },
    message: {
      baseGas: 0n,
      data: '0x1234',
      gasPrice: 0n,
      gasToken: '0x0000000000000000000000000000000000000000',
      nonce: 9n,
      operation: 1,
      refundReceiver: SAFE,
      safeTxGas: 100n,
      to: '0x3333333333333333333333333333333333333333',
      value: 0n,
    },
    primaryType: 'SafeTx',
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
  };
}

describe('injected wallet request', () => {
  it('serializes only the exact Reya Safe EIP-712 payload', () => {
    expect(JSON.parse(walletTypedData(request(), OWNER, SAFE))).toEqual({
      domain: {
        chainId: 1729,
        verifyingContract: SAFE,
      },
      message: {
        baseGas: '0',
        data: '0x1234',
        gasPrice: '0',
        gasToken: '0x0000000000000000000000000000000000000000',
        nonce: '9',
        operation: 1,
        refundReceiver: SAFE,
        safeTxGas: '100',
        to: '0x3333333333333333333333333333333333333333',
        value: '0',
      },
      primaryType: 'SafeTx',
      types: {
        EIP712Domain: [
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        SafeTx: [
          { name: 'to', type: 'address' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
    });
  });

  it('rejects a different owner, chain or extra field', () => {
    expect(() => walletTypedData(request(), SAFE, SAFE)).toThrow('WALLET_REQUEST_REJECTED');
    expect(() =>
      walletTypedData(
        {
          ...request(),
          domain: {
            ...request().domain,
            verifyingContract: '0x3333333333333333333333333333333333333333',
          },
        },
        OWNER,
        SAFE
      )
    ).toThrow('WALLET_REQUEST_REJECTED');
    expect(() =>
      walletTypedData(
        {
          ...request(),
          domain: { ...request().domain, chainId: 1 },
        },
        OWNER,
        SAFE
      )
    ).toThrow('WALLET_REQUEST_REJECTED');
    expect(() => walletTypedData({ ...request(), chain: 1729 }, OWNER, SAFE)).toThrow('WALLET_REQUEST_REJECTED');
  });

  it.each([
    [{ ...request(), primaryType: 'Transaction' }, 'different primary type'],
    [{ ...request(), types: { SafeTx: { name: 'to', type: 'address' } } }, 'non-array SafeTx type'],
    [
      {
        ...request(),
        domain: { ...request().domain, name: 'unexpected' },
      },
      'extra domain field',
    ],
    [
      {
        ...request(),
        domain: { chainId: 1729 },
      },
      'missing domain field',
    ],
    [
      {
        ...request(),
        message: { ...request().message, unexpected: 1 },
      },
      'extra message field',
    ],
    [
      {
        ...request(),
        message: Object.fromEntries(Object.entries(request().message).filter(([key]) => key !== 'data')),
      },
      'missing message field',
    ],
  ])('rejects %s (%s)', (candidate, _description) => {
    expect(() => walletTypedData(candidate, OWNER, SAFE)).toThrow('WALLET_REQUEST_REJECTED');
  });
});
