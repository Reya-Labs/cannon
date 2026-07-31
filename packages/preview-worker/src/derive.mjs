import { encodeFunctionData, hashTypedData, zeroAddress } from 'viem';
import { REYA_CHAIN_ID } from './config.mjs';
import { PreviewError } from './errors.mjs';

export const MULTICALL_ADDRESS = '0xe2c5658cc5c448b48141168f3e475df8f65a1e3e';

export const MULTICALL_AGGREGATE3VALUE_ABI = Object.freeze([
  Object.freeze({
    inputs: Object.freeze([
      Object.freeze({
        components: Object.freeze([
          Object.freeze({ name: 'target', type: 'address' }),
          Object.freeze({ name: 'requireSuccess', type: 'bool' }),
          Object.freeze({ name: 'value', type: 'uint256' }),
          Object.freeze({ name: 'callData', type: 'bytes' }),
        ]),
        name: 'calls',
        type: 'tuple[]',
      }),
    ]),
    name: 'aggregate3Value',
    outputs: Object.freeze([
      Object.freeze({
        components: Object.freeze([
          Object.freeze({ name: 'success', type: 'bool' }),
          Object.freeze({ name: 'returnData', type: 'bytes' }),
        ]),
        name: 'returnData',
        type: 'tuple[]',
      }),
    ]),
    stateMutability: 'payable',
    type: 'function',
  }),
]);

export const SAFE_TX_TYPES = Object.freeze([
  Object.freeze({ name: 'to', type: 'address' }),
  Object.freeze({ name: 'value', type: 'uint256' }),
  Object.freeze({ name: 'data', type: 'bytes' }),
  Object.freeze({ name: 'operation', type: 'uint8' }),
  Object.freeze({ name: 'safeTxGas', type: 'uint256' }),
  Object.freeze({ name: 'baseGas', type: 'uint256' }),
  Object.freeze({ name: 'gasPrice', type: 'uint256' }),
  Object.freeze({ name: 'gasToken', type: 'address' }),
  Object.freeze({ name: 'refundReceiver', type: 'address' }),
  Object.freeze({ name: 'nonce', type: 'uint256' }),
]);

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CALLS = 4_096;

function reject() {
  throw new PreviewError(422, 'PREVIEW_NOT_STAGEABLE');
}

function uint(value) {
  if (typeof value !== 'string' || !UINT_PATTERN.test(value)) reject();
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) reject();
  return parsed;
}

/**
 * Re-checks one Safe call that this process produced.
 *
 * The preview engine already enforces this contract, but the derivation is what
 * a signature commits to, so it re-validates rather than trusting an in-memory
 * hand-off.
 */
function safeCall(call, safeAddress) {
  if (
    call === null ||
    typeof call !== 'object' ||
    call.senderRole !== 'safe' ||
    typeof call.from !== 'string' ||
    call.from !== safeAddress ||
    typeof call.to !== 'string' ||
    !ADDRESS_PATTERN.test(call.to) ||
    typeof call.data !== 'string' ||
    !HEX_PATTERN.test(call.data)
  ) {
    reject();
  }
  return Object.freeze({
    callData: call.data,
    requireSuccess: true,
    target: call.to,
    value: uint(call.value),
  });
}

/**
 * Derives the single stageable Safe transaction and its EIP-712 hash from a
 * preview this process just computed and the Safe nonce this process just read
 * from chain.
 *
 * Nothing here is browser-supplied: `preview` is the return value of the local
 * simulation and `nonce` comes from the Safe contract. A preview that still
 * needs deployer prerequisites is never stageable, because those transactions
 * cannot be authorised by a Safe signature.
 *
 * @param {{deployerPrerequisites: readonly object[], safeAddress: string, safeProposalCalls: readonly object[]}} preview
 * @param {number} nonce
 */
export function deriveSafeTransaction(preview, nonce) {
  if (
    preview === null ||
    typeof preview !== 'object' ||
    !Array.isArray(preview.safeProposalCalls) ||
    !Array.isArray(preview.deployerPrerequisites) ||
    typeof preview.safeAddress !== 'string' ||
    !ADDRESS_PATTERN.test(preview.safeAddress) ||
    !Number.isSafeInteger(nonce) ||
    nonce < 0
  ) {
    reject();
  }
  if (preview.deployerPrerequisites.length !== 0) {
    reject();
  }
  if (
    preview.safeProposalCalls.length < 1 ||
    preview.safeProposalCalls.length > MAX_CALLS
  ) {
    reject();
  }

  const calls = preview.safeProposalCalls.map((call) =>
    safeCall(call, preview.safeAddress),
  );
  const totalValue = calls.reduce((total, call) => total + call.value, 0n);
  const safeTxGas = preview.safeProposalCalls.reduce(
    (total, call) => total + uint(call.gasUsed),
    0n,
  );
  if (totalValue > MAX_UINT256 || safeTxGas > MAX_UINT256) reject();

  let data;
  try {
    data = encodeFunctionData({
      abi: MULTICALL_AGGREGATE3VALUE_ABI,
      args: [calls.map(({ value, ...rest }) => ({ ...rest, value }))],
      functionName: 'aggregate3Value',
    });
  } catch {
    reject();
  }

  const txn = Object.freeze({
    _nonce: nonce,
    baseGas: '0',
    data,
    gasPrice: '0',
    gasToken: zeroAddress,
    operation: '1',
    refundReceiver: preview.safeAddress,
    safeTxGas: safeTxGas.toString(),
    to: MULTICALL_ADDRESS,
    value: totalValue.toString(),
  });

  const typedData = Object.freeze({
    domain: Object.freeze({
      chainId: REYA_CHAIN_ID,
      verifyingContract: preview.safeAddress,
    }),
    message: Object.freeze({
      baseGas: BigInt(txn.baseGas),
      data: txn.data,
      gasPrice: BigInt(txn.gasPrice),
      gasToken: txn.gasToken,
      nonce: BigInt(txn._nonce),
      operation: Number(txn.operation),
      refundReceiver: txn.refundReceiver,
      safeTxGas: BigInt(txn.safeTxGas),
      to: txn.to,
      value: BigInt(txn.value),
    }),
    primaryType: 'SafeTx',
    types: Object.freeze({ SafeTx: SAFE_TX_TYPES }),
  });

  let safeTxHash;
  try {
    safeTxHash = hashTypedData(typedData);
  } catch {
    reject();
  }

  return Object.freeze({ safeTxHash, txn });
}
