import type { AppConfig } from './config';
import { HttpError, QuorumError } from './errors';
import { pinBlockTags, type PreparedRequest } from './schema';
import { UpstreamClient, type UpstreamOutcome } from './upstream';

const CHAIN_ID = 1729n;
const CHAIN_ID_HEX = '0x6c1';
const SAFE_SELECTORS = {
  getOwners: '0xa0e67e2b',
  getThreshold: '0xe75235b8',
  nonce: '0xaffed0e0',
} as const;

type Snapshot = {
  blockHash: string;
  blockNumber: bigint;
  blockTag: string;
  checkedAt: number;
  owners: string[];
  safeNonce: bigint;
  stateRoot: string;
  threshold: bigint;
};

export type GatewayResult =
  | { kind: 'result'; result: unknown }
  | { code: number; data?: string; kind: 'error'; message: string };

function result(outcome: UpstreamOutcome, category: string): unknown {
  if (outcome.kind !== 'result') throw new QuorumError(category);
  return outcome.result;
}

function quantity(value: unknown, category: string): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new QuorumError(category);
  }
  return BigInt(value);
}

function data(value: unknown, category: string): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new QuorumError(category);
  }
  return value.toLowerCase();
}

function block(value: unknown): { hash: string; number: bigint; parentHash: string; stateRoot: string; timestamp: bigint } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new QuorumError('malformed_block');
  const decoded = value as Record<string, unknown>;
  for (const key of ['hash', 'parentHash', 'stateRoot']) {
    if (typeof decoded[key] !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(decoded[key] as string)) {
      throw new QuorumError('malformed_block');
    }
  }
  return {
    hash: (decoded.hash as string).toLowerCase(),
    number: quantity(decoded.number, 'malformed_block'),
    parentHash: (decoded.parentHash as string).toLowerCase(),
    stateRoot: (decoded.stateRoot as string).toLowerCase(),
    timestamp: quantity(decoded.timestamp, 'malformed_block'),
  };
}

function uint256(value: unknown, category: string): bigint {
  const encoded = data(value, category);
  if (!/^0x[0-9a-f]{64}$/.test(encoded)) throw new QuorumError(category);
  return BigInt(encoded);
}

function owners(value: unknown): string[] {
  const encoded = data(value, 'invalid_safe_owners').slice(2);
  if (encoded.length < 128 || encoded.length % 64 !== 0 || BigInt(`0x${encoded.slice(0, 64)}`) !== 32n) {
    throw new QuorumError('invalid_safe_owners');
  }
  const length = Number(BigInt(`0x${encoded.slice(64, 128)}`));
  if (!Number.isSafeInteger(length) || length < 1 || length > 100 || encoded.length !== 128 + length * 64) {
    throw new QuorumError('invalid_safe_owners');
  }
  const decoded: string[] = [];
  for (let index = 0; index < length; index++) {
    const word = encoded.slice(128 + index * 64, 192 + index * 64);
    if (!/^0{24}[0-9a-f]{40}$/.test(word) || /^0{64}$/.test(word)) {
      throw new QuorumError('invalid_safe_owners');
    }
    decoded.push(`0x${word.slice(24)}`);
  }
  if (new Set(decoded).size !== decoded.length) throw new QuorumError('invalid_safe_owners');
  return decoded;
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'string' && /^0x[0-9a-fA-F]*$/.test(item)) return item.toLowerCase();
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)])
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function agree(method: string, left: UpstreamOutcome, right: UpstreamOutcome): GatewayResult {
  if (left.kind !== right.kind) throw new QuorumError('result_error_disagreement');
  if (left.kind === 'error' && right.kind === 'error') {
    if (
      method !== 'eth_call' ||
      left.code !== right.code ||
      left.data === undefined ||
      left.data === '0x' ||
      left.data !== right.data
    ) {
      throw new QuorumError('error_disagreement');
    }
    return {
      code: -32000,
      ...(left.data === undefined ? {} : { data: left.data }),
      kind: 'error',
      message: 'execution reverted',
    };
  }
  if (left.kind !== 'result' || right.kind !== 'result' || canonical(left.result) !== canonical(right.result)) {
    throw new QuorumError('result_disagreement');
  }
  return { kind: 'result', result: left.result };
}

async function waitForAll<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(promises);
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}

function validateResponse(request: PreparedRequest, response: GatewayResult, snapshotBlock: bigint): void {
  if (response.kind === 'error') return;
  const value = response.result;
  if (['eth_getBalance', 'eth_getTransactionCount'].includes(request.method)) {
    quantity(value, 'malformed_method_result');
  } else if (['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(request.method)) {
    data(value, 'malformed_method_result');
  } else if (request.method.startsWith('eth_getBlock') && value !== null) {
    const decoded = block(value);
    if (decoded.number > snapshotBlock) throw new QuorumError('future_method_result');
    if (request.method === 'eth_getBlockByNumber' && decoded.number !== BigInt(request.params[0] as string)) {
      throw new QuorumError('response_request_mismatch');
    }
    if (request.method === 'eth_getBlockByHash' && decoded.hash !== request.params[0]) {
      throw new QuorumError('response_request_mismatch');
    }
  } else if (['eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(request.method) && value !== null) {
    if (typeof value !== 'object' || Array.isArray(value)) throw new QuorumError('malformed_method_result');
    const decoded = value as Record<string, unknown>;
    const blockNumber = decoded.blockNumber;
    if (blockNumber === null || blockNumber === undefined) throw new QuorumError('pending_method_result');
    if (quantity(blockNumber, 'malformed_method_result') > snapshotBlock) {
      throw new QuorumError('future_method_result');
    }
    const responseHash = request.method === 'eth_getTransactionByHash' ? decoded.hash : decoded.transactionHash;
    if (
      typeof responseHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(responseHash) ||
      responseHash.toLowerCase() !== request.params[0]
    ) {
      throw new QuorumError('response_request_mismatch');
    }
  }
}

export class QuorumService {
  private cached?: Snapshot;
  private readonly config: AppConfig;
  private refresh?: Promise<Snapshot>;
  private readonly upstream: UpstreamClient;

  constructor(config: AppConfig, upstream: UpstreamClient) {
    this.config = config;
    this.upstream = upstream;
  }

  async readiness(): Promise<Snapshot> {
    const now = Date.now();
    if (this.cached && now - this.cached.checkedAt <= this.config.quorum.snapshotTtlMs) return this.cached;
    if (!this.refresh) {
      this.refresh = this.buildSnapshot().finally(() => {
        this.refresh = undefined;
      });
    }
    this.cached = await this.refresh;
    return this.cached;
  }

  async execute(request: PreparedRequest): Promise<GatewayResult> {
    const snapshot = await this.readiness();
    if (request.method === 'eth_chainId') return { kind: 'result', result: CHAIN_ID_HEX };
    if (request.method === 'net_version') return { kind: 'result', result: CHAIN_ID.toString() };
    if (request.method === 'eth_blockNumber') return { kind: 'result', result: snapshot.blockTag };
    const pinned = pinBlockTags(request, snapshot.blockNumber);
    const [left, right] = await waitForAll([
      this.upstream.request(0, pinned.method, pinned.params),
      this.upstream.request(1, pinned.method, pinned.params),
    ]);
    const agreed = agree(pinned.method, left, right);
    validateResponse(pinned, agreed, snapshot.blockNumber);
    await this.assertSnapshotCurrent(snapshot);
    return agreed;
  }

  private async both(method: string, params: unknown[]): Promise<[unknown, unknown]> {
    const [left, right] = await waitForAll([
      this.upstream.request(0, method, params),
      this.upstream.request(1, method, params),
    ]);
    return [result(left, `${method}_provider_0`), result(right, `${method}_provider_1`)];
  }

  private async buildSnapshot(): Promise<Snapshot> {
    const [chains, heads] = await waitForAll([this.both('eth_chainId', []), this.both('eth_blockNumber', [])]);
    if (chains.some((value) => quantity(value, 'chain_mismatch') !== CHAIN_ID)) throw new QuorumError('chain_mismatch');
    const headNumbers = heads.map((value) => quantity(value, 'malformed_head'));
    const highest = headNumbers[0] > headNumbers[1] ? headNumbers[0] : headNumbers[1];
    const lowest = headNumbers[0] < headNumbers[1] ? headNumbers[0] : headNumbers[1];
    if (highest - lowest > BigInt(this.config.quorum.maxHeadLagBlocks)) throw new QuorumError('head_lag');
    const blockTag = `0x${lowest.toString(16)}`;
    const blocks = await this.both('eth_getBlockByNumber', [blockTag, false]);
    const decodedBlocks = blocks.map(block);
    if (
      decodedBlocks.some((item) => item.number !== lowest) ||
      canonical(decodedBlocks[0]) !== canonical(decodedBlocks[1])
    ) {
      throw new QuorumError('block_disagreement');
    }
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const age = nowSeconds - decodedBlocks[0].timestamp;
    if (age > BigInt(this.config.quorum.maxBlockAgeSeconds) || age < -BigInt(this.config.quorum.maxFutureSkewSeconds)) {
      throw new QuorumError('stale_block');
    }
    const call = (selector: string) => this.both('eth_call', [{ data: selector, to: this.config.safeAddress }, blockTag]);
    const [codes, nonces, ownerValues, thresholds] = await waitForAll([
      this.both('eth_getCode', [this.config.safeAddress, blockTag]),
      call(SAFE_SELECTORS.nonce),
      call(SAFE_SELECTORS.getOwners),
      call(SAFE_SELECTORS.getThreshold),
    ]);
    if (codes.map((value) => data(value, 'invalid_safe_code')).some((value) => value === '0x')) {
      throw new QuorumError('invalid_safe_code');
    }
    for (const pair of [codes, nonces, ownerValues, thresholds]) {
      if (canonical(pair[0]) !== canonical(pair[1])) throw new QuorumError('safe_state_disagreement');
    }
    const decodedOwners = owners(ownerValues[0]);
    const threshold = uint256(thresholds[0], 'invalid_safe_threshold');
    if (threshold < 1n || threshold > BigInt(decodedOwners.length)) throw new QuorumError('invalid_safe_threshold');
    const snapshot = {
      blockHash: decodedBlocks[0].hash,
      blockNumber: lowest,
      blockTag,
      checkedAt: Date.now(),
      owners: decodedOwners,
      safeNonce: uint256(nonces[0], 'invalid_safe_nonce'),
      stateRoot: decodedBlocks[0].stateRoot,
      threshold,
    };
    await this.assertSnapshotCurrent(snapshot);
    return snapshot;
  }

  private async assertSnapshotCurrent(snapshot: Snapshot): Promise<void> {
    const values = await this.both('eth_getBlockByNumber', [snapshot.blockTag, false]);
    const current = values.map(block);
    if (
      current.some(
        (candidate) =>
          candidate.number !== snapshot.blockNumber ||
          candidate.hash !== snapshot.blockHash ||
          candidate.stateRoot !== snapshot.stateRoot
      )
    ) {
      throw new QuorumError('snapshot_reorg');
    }
  }
}

export function toUnavailable(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(503, 'rpc_quorum_unavailable', 'RPC provider quorum is temporarily unavailable');
}
