/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertRpcChain, createRpcClient } from '../src/helpers/rpc';

describe('registry RPC chain preflight', () => {
  it('selects WebSocket transport for ws and wss URLs', () => {
    assert.equal(createRpcClient('mainnet', 'ws://127.0.0.1:8545').transport.type, 'webSocket');
    assert.equal(createRpcClient('mainnet', 'wss://mainnet.example.com').transport.type, 'webSocket');
    assert.equal(createRpcClient('mainnet', 'http://127.0.0.1:8545').transport.type, 'http');
    assert.equal(createRpcClient('mainnet', 'https://mainnet.example.com').transport.type, 'http');
  });

  it('accepts the expected provider chain', async () => {
    let calls = 0;
    const getChainId = async () => {
      calls++;
      return 1;
    };

    await assert.doesNotReject(assertRpcChain({ getChainId }, 1, 'mainnet'));
    assert.equal(calls, 1);
  });

  it('rejects a swapped provider before registry state can initialize', async () => {
    let calls = 0;
    const getChainId = async () => {
      calls++;
      return 10;
    };

    await assert.rejects(
      assertRpcChain({ getChainId }, 1, 'mainnet'),
      /mainnet RPC chain mismatch: expected 1, received 10/
    );
    assert.equal(calls, 1);
  });
});
