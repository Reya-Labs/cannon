import type { AppConfig } from '../src/config';
import type { UpstreamOutcome } from '../src/upstream';

export const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111';

export function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    auth: {
      identityHeader: 'x-reya-user',
      proxySecret: 'x'.repeat(32),
      proxySecretHeader: 'x-reya-proxy-secret',
    },
    limits: {
      bodyBytes: 131_072,
      calldataBytes: 65_536,
      concurrency: 16,
      queue: 64,
      rateLimit: 60,
      rateLimitWindowMs: 60_000,
      responseBytes: 2_097_152,
    },
    port: 8080,
    quorum: {
      maxBlockAgeSeconds: 120,
      maxFutureSkewSeconds: 30,
      maxHeadLagBlocks: 2,
      snapshotTtlMs: 10_000,
      timeoutMs: 1000,
    },
    safeAddress: SAFE_ADDRESS,
    trustProxy: false,
    uiOrigin: 'https://safe.reya.network',
    upstreams: [new URL('https://provider-a.example/rpc/secret-a'), new URL('https://provider-b.example/rpc/secret-b')],
    ...overrides,
  };
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function addressWord(value: string): string {
  return value.slice(2).toLowerCase().padStart(64, '0');
}

export function encodedOwners(values = ['0x2222222222222222222222222222222222222222']): string {
  return `0x${word(32n)}${word(BigInt(values.length))}${values.map(addressWord).join('')}`;
}

export function encodedUint(value: bigint): string {
  return `0x${word(value)}`;
}

export class FakeUpstream {
  readonly calls: Array<{ method: string; params: unknown[]; provider: 0 | 1 }> = [];
  disagreeMethod?: string;
  override?: (provider: 0 | 1, method: string, params: unknown[], result: unknown) => unknown;
  timestamp = BigInt(Math.floor(Date.now() / 1000));

  async request(provider: 0 | 1, method: string, params: unknown[]): Promise<UpstreamOutcome> {
    this.calls.push({ method, params, provider });
    let result: unknown;
    if (method === 'eth_chainId') result = '0x6c1';
    else if (method === 'eth_blockNumber') result = provider === 0 ? '0x64' : '0x65';
    else if (method === 'eth_getBlockByNumber') {
      result = {
        hash: `0x${'12'.repeat(32)}`,
        number: params[0],
        parentHash: `0x${'34'.repeat(32)}`,
        stateRoot: `0x${'56'.repeat(32)}`,
        timestamp: `0x${this.timestamp.toString(16)}`,
        transactions: [],
      };
    } else if (method === 'eth_getCode') result = '0x6001';
    else if (method === 'eth_call') {
      const call = params[0] as { data: string };
      if (call.data === '0xaffed0e0') result = encodedUint(7n);
      else if (call.data === '0xa0e67e2b') result = encodedOwners();
      else if (call.data === '0xe75235b8') result = encodedUint(1n);
      else result = '0x1234';
    } else if (method === 'eth_getBalance') result = '0x10';
    else if (method === 'eth_getTransactionCount') result = '0x2';
    else result = null;
    if (this.disagreeMethod === method && provider === 1) result = method === 'eth_getCode' ? '0x6002' : '0x11';
    if (this.override) result = this.override(provider, method, params, result);
    return { kind: 'result', result };
  }
}
