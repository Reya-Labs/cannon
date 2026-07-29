import { describe, expect, it } from 'vitest';
import { QuorumService } from '../src/quorum';
import type { PreparedRequest } from '../src/schema';
import type { UpstreamClient, UpstreamOutcome } from '../src/upstream';
import { config, encodedOwners, encodedUint, FakeUpstream } from './fixtures';

function service(fake: FakeUpstream, overrides = {}) {
  return new QuorumService(config(overrides), fake as unknown as UpstreamClient);
}

describe('QuorumService', () => {
  it('builds a fresh common-block Safe snapshot and pins dual reads to it', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    const snapshot = await quorum.readiness();
    expect(snapshot.blockTag).toBe('0x64');
    expect(snapshot.safeNonce).toBe(7n);
    expect(snapshot.threshold).toBe(1n);

    const request: PreparedRequest = {
      cost: 1,
      id: 1,
      method: 'eth_getBalance',
      params: ['0x1111111111111111111111111111111111111111', 'latest'],
    };
    await expect(quorum.execute(request)).resolves.toEqual({ kind: 'result', result: '0x10' });
    expect(fake.calls.filter((call) => call.method === 'eth_getBalance')).toEqual([
      { method: 'eth_getBalance', params: [request.params[0], '0x64'], provider: 0 },
      { method: 'eth_getBalance', params: [request.params[0], '0x64'], provider: 1 },
    ]);
  });

  it('fails closed on provider disagreement and stale blocks', async () => {
    const disagreement = new FakeUpstream();
    disagreement.disagreeMethod = 'eth_getCode';
    await expect(service(disagreement).readiness()).rejects.toMatchObject({ category: 'safe_state_disagreement' });

    const stale = new FakeUpstream();
    stale.timestamp -= 1000n;
    await expect(service(stale).readiness()).rejects.toMatchObject({ category: 'stale_block' });
  });

  it('fails closed when a state read disagrees after readiness', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    fake.disagreeMethod = 'eth_getBalance';
    await expect(
      quorum.execute({
        cost: 1,
        id: 1,
        method: 'eth_getBalance',
        params: ['0x1111111111111111111111111111111111111111', 'latest'],
      })
    ).rejects.toMatchObject({ category: 'result_disagreement' });
  });

  it.each([
    [
      'chain mismatch',
      (provider: 0 | 1, method: string, _params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_chainId' ? '0x1' : value,
      'chain_mismatch',
    ],
    [
      'excessive head lag',
      (provider: 0 | 1, method: string, _params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_blockNumber' ? '0x70' : value,
      'head_lag',
    ],
    [
      'common block mismatch',
      (provider: 0 | 1, method: string, _params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_getBlockByNumber'
          ? { ...(value as Record<string, unknown>), hash: `0x${'99'.repeat(32)}` }
          : value,
      'block_disagreement',
    ],
    [
      'Safe nonce disagreement',
      (provider: 0 | 1, method: string, params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_call' && (params[0] as { data?: string }).data === '0xaffed0e0'
          ? '0x'.concat('8'.padStart(64, '0'))
          : value,
      'safe_state_disagreement',
    ],
    [
      'Safe owners disagreement',
      (provider: 0 | 1, method: string, params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_call' && (params[0] as { data?: string }).data === '0xa0e67e2b'
          ? encodedOwners(['0x3333333333333333333333333333333333333333'])
          : value,
      'safe_state_disagreement',
    ],
    [
      'Safe threshold disagreement',
      (provider: 0 | 1, method: string, params: unknown[], value: unknown) =>
        provider === 1 && method === 'eth_call' && (params[0] as { data?: string }).data === '0xe75235b8'
          ? encodedUint(2n)
          : value,
      'safe_state_disagreement',
    ],
  ])('fails closed on %s', async (_label, override, category) => {
    const fake = new FakeUpstream();
    fake.override = override;
    await expect(service(fake).readiness()).rejects.toMatchObject({ category });
  });

  it('rejects future block timestamps and invalid Safe threshold invariants', async () => {
    const future = new FakeUpstream();
    future.timestamp += 1000n;
    await expect(service(future).readiness()).rejects.toMatchObject({ category: 'stale_block' });

    const invalidThreshold = new FakeUpstream();
    invalidThreshold.override = (_provider, method, params, value) =>
      method === 'eth_call' && (params[0] as { data?: string }).data === '0xe75235b8' ? encodedUint(2n) : value;
    await expect(service(invalidThreshold).readiness()).rejects.toMatchObject({ category: 'invalid_safe_threshold' });
  });

  it.each([
    [
      'eth_getBlockByNumber',
      ['0x10', false],
      {
        hash: `0x${'12'.repeat(32)}`,
        number: '0x11',
        parentHash: `0x${'34'.repeat(32)}`,
        stateRoot: `0x${'56'.repeat(32)}`,
        timestamp: '0x1',
      },
    ],
    [
      'eth_getBlockByHash',
      [`0x${'aa'.repeat(32)}`, false],
      {
        hash: `0x${'bb'.repeat(32)}`,
        number: '0x10',
        parentHash: `0x${'34'.repeat(32)}`,
        stateRoot: `0x${'56'.repeat(32)}`,
        timestamp: '0x1',
      },
    ],
    ['eth_getTransactionByHash', [`0x${'aa'.repeat(32)}`], { blockNumber: '0x10', hash: `0x${'bb'.repeat(32)}` }],
    [
      'eth_getTransactionReceipt',
      [`0x${'aa'.repeat(32)}`],
      { blockNumber: '0x10', transactionHash: `0x${'bb'.repeat(32)}` },
    ],
  ])('binds %s responses to the requested identifier', async (method, params, wrongResult) => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    fake.override = (_provider, candidateMethod, _params, value) => (candidateMethod === method ? wrongResult : value);
    await expect(quorum.execute({ cost: 1, id: 1, method, params })).rejects.toMatchObject({
      category: 'response_request_mismatch',
    });
  });

  it('waits for a slow sibling provider before releasing a failed quorum request', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    const original = fake.request.bind(fake);
    let releaseSlow: (() => void) | undefined;
    let signalSlow: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      signalSlow = resolve;
    });
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    fake.request = async (provider, method, params) => {
      if (method !== 'eth_getBalance') return original(provider, method, params);
      if (provider === 0) throw new Error('fast failure');
      signalSlow?.();
      await slow;
      return { kind: 'result', result: '0x10' };
    };
    const execution = quorum.execute({
      cost: 1,
      id: 1,
      method: 'eth_getBalance',
      params: ['0x1111111111111111111111111111111111111111', 'latest'],
    });
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await slowStarted;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    releaseSlow?.();
    await expect(execution).rejects.toThrow('fast failure');
  });

  it('rejects a same-height reorg between cached readiness and a dual state read', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    fake.override = (_provider, method, _params, value) =>
      method === 'eth_getBlockByNumber'
        ? {
            ...(value as Record<string, unknown>),
            hash: `0x${'99'.repeat(32)}`,
            stateRoot: `0x${'88'.repeat(32)}`,
          }
        : value;
    await expect(
      quorum.execute({
        cost: 1,
        id: 1,
        method: 'eth_getBalance',
        params: ['0x1111111111111111111111111111111111111111', 'latest'],
      })
    ).rejects.toMatchObject({ category: 'snapshot_reorg' });
  });

  it('rejects a same-height reorg during Safe readiness construction', async () => {
    const fake = new FakeUpstream();
    let blockResponses = 0;
    fake.override = (_provider, method, _params, value) => {
      if (method !== 'eth_getBlockByNumber' || ++blockResponses <= 2) return value;
      return {
        ...(value as Record<string, unknown>),
        hash: `0x${'99'.repeat(32)}`,
        stateRoot: `0x${'88'.repeat(32)}`,
      };
    };
    await expect(service(fake).readiness()).rejects.toMatchObject({ category: 'snapshot_reorg' });
  });

  it('passes through only matching non-empty eth_call revert data', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    const original = fake.request.bind(fake);
    fake.request = async (provider, method, params) =>
      method === 'eth_call' && (params[0] as { data?: string }).data === '0x1234'
        ? { code: -32_000, data: '0xdeadbeef', kind: 'error' }
        : original(provider, method, params);
    await expect(
      quorum.execute({
        cost: 3,
        id: 1,
        method: 'eth_call',
        params: [{ data: '0x1234', to: '0x1111111111111111111111111111111111111111' }, 'latest'],
      })
    ).resolves.toMatchObject({ data: '0xdeadbeef', kind: 'error', message: 'execution reverted' });
  });

  it('rejects same-code provider errors without matching revert data', async () => {
    const fake = new FakeUpstream();
    const quorum = service(fake);
    await quorum.readiness();
    const original = fake.request.bind(fake);
    fake.request = async (provider, method, params) =>
      method === 'eth_call' && (params[0] as { data?: string }).data === '0x1234'
        ? ({
            code: -32_000,
            kind: 'error',
            message: provider === 0 ? 'execution reverted' : 'header not found',
          } as UpstreamOutcome)
        : original(provider, method, params);
    await expect(
      quorum.execute({
        cost: 3,
        id: 1,
        method: 'eth_call',
        params: [{ data: '0x1234', to: '0x1111111111111111111111111111111111111111' }, 'latest'],
      })
    ).rejects.toMatchObject({ category: 'error_disagreement' });
  });
});
