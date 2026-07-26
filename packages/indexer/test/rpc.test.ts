import { describe, expect, it, vi } from 'vitest';
import { assertRpcChain } from '../src/helpers/rpc';

describe('registry RPC chain preflight', () => {
  it('accepts the expected provider chain', async () => {
    const getChainId = vi.fn().mockResolvedValue(1);

    await expect(assertRpcChain({ getChainId }, 1, 'mainnet')).resolves.toBeUndefined();
    expect(getChainId).toHaveBeenCalledOnce();
  });

  it('rejects a swapped provider before registry state can initialize', async () => {
    const getChainId = vi.fn().mockResolvedValue(10);

    await expect(assertRpcChain({ getChainId }, 1, 'mainnet')).rejects.toThrow(
      'mainnet RPC chain mismatch: expected 1, received 10'
    );
    expect(getChainId).toHaveBeenCalledOnce();
  });
});
