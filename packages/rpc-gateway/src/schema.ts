import { HttpError } from './errors';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DATA_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const ALLOWED_KEYS = new Set(['jsonrpc', 'method', 'params', 'id']);

export type RpcRequest = {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
};

export type PreparedRequest = {
  cost: number;
  id: number;
  method: string;
  params: unknown[];
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactLength(params: unknown[], expected: number): void {
  if (params.length !== expected) {
    throw new HttpError(400, 'invalid_params', 'RPC method parameters do not match the allowed schema');
  }
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_params', 'RPC method parameters do not match the allowed schema');
  }
  return value.toLowerCase();
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_params', 'RPC method parameters do not match the allowed schema');
  }
  return value.toLowerCase();
}

function quantity(value: unknown): string {
  if (typeof value !== 'string' || !QUANTITY_PATTERN.test(value)) {
    throw new HttpError(400, 'invalid_params', 'RPC method parameters do not match the allowed schema');
  }
  return value;
}

function block(value: unknown): string {
  if (value === 'latest') return value;
  return quantity(value);
}

function data(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' || !DATA_PATTERN.test(value) || (value.length - 2) / 2 > maximumBytes) {
    throw new HttpError(400, 'invalid_params', 'RPC calldata exceeds the allowed schema or size');
  }
  return value.toLowerCase();
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, 'invalid_params', 'RPC method parameters do not match the allowed schema');
  }
  return value;
}

function callObject(value: unknown, maximumBytes: number): Record<string, unknown> {
  const decoded = record(value, 'eth_call transaction');
  const allowed = new Set(['data', 'from', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'to', 'value']);
  if (Object.keys(decoded).some((key) => !allowed.has(key)) || typeof decoded.to !== 'string') {
    throw new HttpError(400, 'invalid_params', 'eth_call state overrides and unknown transaction fields are forbidden');
  }
  const result: Record<string, unknown> = { to: address(decoded.to) };
  if (decoded.from !== undefined) result.from = address(decoded.from);
  if (decoded.data !== undefined) result.data = data(decoded.data, maximumBytes);
  for (const key of ['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value']) {
    if (decoded[key] !== undefined) result[key] = quantity(decoded[key]);
  }
  if (result.gas !== undefined && BigInt(result.gas as string) > 30_000_000n) {
    throw new HttpError(400, 'invalid_params', 'eth_call gas exceeds the configured safety bound');
  }
  return result;
}

/**
 * Decodes one strict JSON-RPC 2.0 request envelope.
 *
 * Batches and unknown, missing, or invalid framing fields are rejected with a
 * 400 error. Method-specific validation is performed by {@link prepareRequest}.
 */
export function decodeRpcRequest(value: unknown): RpcRequest {
  if (Array.isArray(value)) {
    throw new HttpError(400, 'batch_forbidden', 'JSON-RPC batches are disabled for the initial gateway');
  }
  const decoded = record(value, 'JSON-RPC request');
  if (Object.keys(decoded).some((key) => !ALLOWED_KEYS.has(key)) || Object.keys(decoded).length !== 4) {
    throw new HttpError(400, 'invalid_request', 'JSON-RPC request must contain exactly jsonrpc, method, params, and id');
  }
  if (
    decoded.jsonrpc !== '2.0' ||
    typeof decoded.method !== 'string' ||
    !Array.isArray(decoded.params) ||
    !Number.isSafeInteger(decoded.id) ||
    (decoded.id as number) < 0
  ) {
    throw new HttpError(400, 'invalid_request', 'JSON-RPC framing is invalid');
  }
  return decoded as RpcRequest;
}

/**
 * Validates and normalizes a request against the read-only RPC allowlist.
 *
 * The returned request carries its weighted limiter cost. Method parameters are
 * normalized and `eth_call` calldata is bounded by `maximumCalldataBytes`;
 * unsupported methods and invalid parameters are rejected.
 */
export function prepareRequest(request: RpcRequest, maximumCalldataBytes: number): PreparedRequest {
  const params = request.params;
  let prepared: unknown[];
  let cost = 1;
  switch (request.method) {
    case 'eth_chainId':
    case 'net_version':
    case 'eth_blockNumber':
      exactLength(params, 0);
      prepared = [];
      break;
    case 'eth_getBlockByNumber':
      exactLength(params, 2);
      prepared = [block(params[0]), boolean(params[1])];
      cost = params[1] === true ? 5 : 2;
      break;
    case 'eth_getBlockByHash':
      exactLength(params, 2);
      prepared = [hash(params[0]), boolean(params[1])];
      cost = params[1] === true ? 5 : 2;
      break;
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_getCode':
      exactLength(params, 2);
      prepared = [address(params[0]), block(params[1])];
      break;
    case 'eth_getStorageAt':
      exactLength(params, 3);
      prepared = [address(params[0]), hash(params[1]), block(params[2])];
      break;
    case 'eth_call':
      exactLength(params, 2);
      prepared = [callObject(params[0], maximumCalldataBytes), block(params[1])];
      cost = 3;
      break;
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
      exactLength(params, 1);
      prepared = [hash(params[0])];
      break;
    default:
      throw new HttpError(403, 'method_forbidden', 'RPC method is not in the read-only allowlist');
  }
  return { cost, id: request.id, method: request.method, params: prepared };
}

/**
 * Returns a cloned request pinned to the agreed provider snapshot.
 *
 * Every supported `latest` block selector becomes `snapshotBlock`. Explicit
 * blocks newer than the snapshot are rejected, while historical selectors and
 * the original request remain unchanged.
 */
export function pinBlockTags(request: PreparedRequest, snapshotBlock: bigint): PreparedRequest {
  const params = structuredClone(request.params);
  const indices: Record<string, number[]> = {
    eth_call: [1],
    eth_getBalance: [1],
    eth_getBlockByNumber: [0],
    eth_getCode: [1],
    eth_getStorageAt: [2],
    eth_getTransactionCount: [1],
  };
  for (const index of indices[request.method] ?? []) {
    const tag = params[index] as string;
    if (tag === 'latest') {
      params[index] = `0x${snapshotBlock.toString(16)}`;
    } else if (BigInt(tag) > snapshotBlock) {
      throw new HttpError(400, 'future_block_forbidden', 'requested block is newer than the agreed provider snapshot');
    }
  }
  return { ...request, params };
}
