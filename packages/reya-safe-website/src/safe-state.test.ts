import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { readReyaSafeState } from './safe-state';

const SAFE = '0x1111111111111111111111111111111111111111';
const OWNER_A = '0x2222222222222222222222222222222222222222';
const OWNER_B = '0x3333333333333333333333333333333333333333';
const BLOCK = '0x123';

type Overrides = {
  blockNumber?: unknown;
  chainId?: unknown;
  code?: unknown;
  nonce?: bigint;
  owners?: readonly `0x${string}`[];
  threshold?: bigint;
};

function rpc(overrides: Overrides = {}) {
  const observed: Array<{ method: string; params: unknown[] }> = [];
  const values = {
    blockNumber: BLOCK,
    chainId: '0x6c1',
    code: '0x6000',
    nonce: 9n,
    owners: [OWNER_B, OWNER_A],
    threshold: 2n,
    ...overrides,
  };
  return {
    observed,
    read: async (input: { method: string; params: unknown[] }) => {
      observed.push(input);
      if (input.method === 'eth_chainId') return values.chainId;
      if (input.method === 'eth_blockNumber') return values.blockNumber;
      if (input.method === 'eth_getCode') return values.code;
      if (input.method !== 'eth_call') throw new Error('unexpected method');
      const call = input.params[0] as { data: string };
      if (call.data === toFunctionSelector('nonce()')) {
        return encodeAbiParameters([{ type: 'uint256' }], [values.nonce]);
      }
      if (call.data === toFunctionSelector('getOwners()')) {
        return encodeAbiParameters([{ type: 'address[]' }], [values.owners as `0x${string}`[]]);
      }
      if (call.data === toFunctionSelector('getThreshold()')) {
        return encodeAbiParameters([{ type: 'uint256' }], [values.threshold]);
      }
      throw new Error('unexpected Safe selector');
    },
  };
}

describe('Reya Safe state admission', () => {
  it('pins contract code and all Safe calls to one observed block', async () => {
    const client = rpc();

    await expect(readReyaSafeState(client, SAFE)).resolves.toEqual({
      nonce: 9,
      owners: [OWNER_A, OWNER_B],
      threshold: 2,
    });
    const stateReads = client.observed.filter(({ method }) => ['eth_getCode', 'eth_call'].includes(method));
    expect(stateReads).toHaveLength(4);
    expect(stateReads.every(({ params }) => params.at(-1) === BLOCK)).toBe(true);
  });

  it.each([
    [{ chainId: '0x1' }, 'wrong chain'],
    [{ blockNumber: 'latest' }, 'non-quantity block'],
    [{ blockNumber: '0x01' }, 'non-canonical block'],
    [{ code: '0x' }, 'missing contract'],
    [{ nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, 'unsafe nonce'],
    [{ owners: [] }, 'empty owners'],
    [{ owners: [OWNER_A, OWNER_A] }, 'duplicate owners'],
    [{ threshold: 0n }, 'zero threshold'],
    [{ threshold: 3n }, 'threshold above owner count'],
  ] as const)('rejects %s (%s)', async (overrides, description) => {
    void description;
    await expect(readReyaSafeState(rpc(overrides as Overrides), SAFE)).rejects.toThrow('SAFE_STATE_REJECTED');
  });
});
