import { decodeFunctionResult, encodeFunctionData, getAddress } from 'viem';
import { PreviewError } from './errors.mjs';
import { ethCall } from './rpc.mjs';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const MAX_OWNERS = 128;

export const SAFE_STATE_ABI = Object.freeze([
  Object.freeze({
    inputs: Object.freeze([]),
    name: 'nonce',
    outputs: Object.freeze([Object.freeze({ name: '', type: 'uint256' })]),
    stateMutability: 'view',
    type: 'function',
  }),
  Object.freeze({
    inputs: Object.freeze([]),
    name: 'getThreshold',
    outputs: Object.freeze([Object.freeze({ name: '', type: 'uint256' })]),
    stateMutability: 'view',
    type: 'function',
  }),
  Object.freeze({
    inputs: Object.freeze([]),
    name: 'getOwners',
    outputs: Object.freeze([Object.freeze({ name: '', type: 'address[]' })]),
    stateMutability: 'view',
    type: 'function',
  }),
  Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ name: 'to', type: 'address' }),
      Object.freeze({ name: 'value', type: 'uint256' }),
      Object.freeze({ name: 'data', type: 'bytes' }),
      Object.freeze({ name: 'operation', type: 'uint8' }),
      Object.freeze({ name: 'safeTxGas', type: 'uint256' }),
      Object.freeze({ name: 'baseGas', type: 'uint256' }),
      Object.freeze({ name: 'gasPrice', type: 'uint256' }),
      Object.freeze({ name: 'gasToken', type: 'address' }),
      Object.freeze({ name: 'refundReceiver', type: 'address' }),
      Object.freeze({ name: '_nonce', type: 'uint256' }),
    ]),
    name: 'getTransactionHash',
    outputs: Object.freeze([Object.freeze({ name: '', type: 'bytes32' })]),
    stateMutability: 'view',
    type: 'function',
  }),
]);

async function readSafe({
  args = [],
  fetchImpl,
  functionName,
  safeAddress,
  url,
}) {
  let data;
  try {
    data = encodeFunctionData({
      abi: SAFE_STATE_ABI,
      args,
      functionName,
    });
  } catch {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  const result = await ethCall({ data, fetchImpl, to: safeAddress, url });
  try {
    return decodeFunctionResult({
      abi: SAFE_STATE_ABI,
      data: result,
      functionName,
    });
  } catch {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
}

function boundedCount(value, label) {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  void label;
  return Number(value);
}

/**
 * Reads the live Safe nonce, threshold and owner set.
 *
 * This is the "current chain/Safe state" half of the derivation. The browser
 * supplies none of it, so a stale or forged nonce cannot shift the transaction
 * a signer is asked to sign.
 *
 * @param {{fetchImpl?: typeof fetch, safeAddress: string, url: string}} options
 */
export async function readSafeState({ fetchImpl, safeAddress, url }) {
  if (typeof safeAddress !== 'string' || !ADDRESS_PATTERN.test(safeAddress)) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  const [nonce, threshold, owners] = await Promise.all([
    readSafe({ fetchImpl, functionName: 'nonce', safeAddress, url }),
    readSafe({ fetchImpl, functionName: 'getThreshold', safeAddress, url }),
    readSafe({ fetchImpl, functionName: 'getOwners', safeAddress, url }),
  ]);
  if (
    !Array.isArray(owners) ||
    owners.length < 1 ||
    owners.length > MAX_OWNERS ||
    owners.some(
      (owner) =>
        typeof owner !== 'string' ||
        !ADDRESS_PATTERN.test(String(owner).toLowerCase()),
    )
  ) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  const canonicalOwners = Object.freeze(
    [...new Set(owners.map((owner) => getAddress(owner).toLowerCase()))].sort(),
  );
  const boundedThreshold = boundedCount(threshold, 'threshold');
  if (
    canonicalOwners.length !== owners.length ||
    boundedThreshold < 1 ||
    boundedThreshold > canonicalOwners.length
  ) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  return Object.freeze({
    nonce: boundedCount(nonce, 'nonce'),
    owners: canonicalOwners,
    threshold: boundedThreshold,
  });
}

/**
 * Asks the Safe contract for its own transaction hash and requires it to equal
 * the locally derived EIP-712 digest.
 *
 * This closes the gap between the worker's typed-data construction and the
 * deployed Safe implementation: a domain-separator, version or field-ordering
 * divergence fails the request instead of producing a hash no owner should sign.
 *
 * @param {{fetchImpl?: typeof fetch, expected: string, safeAddress: string, txn: object, url: string}} options
 */
export async function confirmSafeDigest({
  expected,
  fetchImpl,
  safeAddress,
  txn,
  url,
}) {
  if (typeof expected !== 'string' || !HASH_PATTERN.test(expected)) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  const onChain = await readSafe({
    args: [
      txn.to,
      BigInt(txn.value),
      txn.data,
      Number(txn.operation),
      BigInt(txn.safeTxGas),
      BigInt(txn.baseGas),
      BigInt(txn.gasPrice),
      txn.gasToken,
      txn.refundReceiver,
      BigInt(txn._nonce),
    ],
    fetchImpl,
    functionName: 'getTransactionHash',
    safeAddress,
    url,
  });
  if (
    typeof onChain !== 'string' ||
    onChain.toLowerCase() !== expected.toLowerCase()
  ) {
    throw new PreviewError(503, 'SAFE_STATE_UNAVAILABLE');
  }
  return expected.toLowerCase();
}
