import { describe, expect, it } from 'vitest';
import { decodeRpcRequest, pinBlockTags, prepareRequest } from '../src/schema';

function request(method: string, params: unknown[] = []) {
  return decodeRpcRequest({ id: 1, jsonrpc: '2.0', method, params });
}

describe('RPC schema', () => {
  it.each([
    'eth_accounts',
    'eth_sendRawTransaction',
    'eth_sign',
    'personal_sign',
    'wallet_addEthereumChain',
    'admin_peers',
    'debug_traceCall',
    'trace_call',
    'txpool_status',
    'engine_newPayloadV3',
    'miner_start',
    'evm_mine',
    'anvil_setBalance',
    'hardhat_setCode',
    'ETH_CALL',
    'eth_\u0430ccounts',
  ])('default-denies %s', (method) => {
    expect(() => prepareRequest(request(method), 64)).toThrow('not in the read-only allowlist');
  });

  it('rejects batches, notifications, string IDs, and unknown framing fields', () => {
    expect(() => decodeRpcRequest([])).toThrow('batches are disabled');
    expect(() => decodeRpcRequest({ jsonrpc: '2.0', method: 'eth_chainId', params: [] })).toThrow('exactly');
    expect(() => decodeRpcRequest({ id: '1', jsonrpc: '2.0', method: 'eth_chainId', params: [] })).toThrow('framing');
    expect(() => decodeRpcRequest({ extra: true, id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })).toThrow(
      'exactly'
    );
  });

  it('pins latest and rejects pending, state overrides, excessive calldata, and future blocks', () => {
    const call = prepareRequest(
      request('eth_call', [{ data: '0x1234', to: '0x1111111111111111111111111111111111111111' }, 'latest']),
      2
    );
    expect(pinBlockTags(call, 16n).params[1]).toBe('0x10');
    expect(() =>
      prepareRequest(
        request('eth_call', [
          { to: '0x1111111111111111111111111111111111111111' },
          'latest',
          { '0x1111111111111111111111111111111111111111': {} },
        ]),
        2
      )
    ).toThrow('parameters');
    expect(() =>
      prepareRequest(
        request('eth_call', [{ data: '0x123456', to: '0x1111111111111111111111111111111111111111' }, 'latest']),
        2
      )
    ).toThrow('calldata');
    expect(() =>
      prepareRequest(request('eth_getBalance', ['0x1111111111111111111111111111111111111111', 'pending']), 2)
    ).toThrow('parameters');
    expect(() =>
      pinBlockTags(prepareRequest(request('eth_getBalance', ['0x1111111111111111111111111111111111111111', '0x11']), 2), 16n)
    ).toThrow('newer');
  });
});
