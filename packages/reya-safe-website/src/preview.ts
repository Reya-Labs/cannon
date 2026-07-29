import MulticallABI from '@cannon/abi/Multicall.json';
import { SafeTransaction } from '@cannon/types/SafeTransaction';
import { encodeFunctionData, zeroAddress } from 'viem';

const MULTICALL_ADDRESS = '0xe2c5658cc5c448b48141168f3e475df8f65a1e3e' as const;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const UINT_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const MAX_CALLS = 4096;
const MAX_CALLDATA_BYTES = 512 * 1024;

export type ReyaPreviewCall = Readonly<{
  data: `0x${string}`;
  from: `0x${string}`;
  gasUsed: string;
  senderRole: 'safe';
  sequence: number;
  step: string;
  to: `0x${string}`;
  transactionHash: `0x${string}`;
  value: string;
}>;

export type ReyaPreview = Readonly<{
  commit: string;
  deployerPrerequisiteCount: number;
  previousDeployCid: string;
  safeAddress: `0x${string}`;
  safeProposalCalls: readonly ReyaPreviewCall[];
  sourceBundleSha256: string;
}>;

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error('PREVIEW_REJECTED');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some(
      (key) => typeof key !== 'string' || !expected.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
    )
  ) {
    throw new Error('PREVIEW_REJECTED');
  }
}

function uint(value: unknown): string {
  if (typeof value !== 'string' || !UINT_PATTERN.test(value) || BigInt(value) >= 1n << 256n) {
    throw new Error('PREVIEW_REJECTED');
  }
  return value;
}

type SimulationCall = Omit<ReyaPreviewCall, 'senderRole' | 'to'> &
  Readonly<{
    senderRole: 'deployer' | 'safe';
    to: `0x${string}` | null;
  }>;

function simulationCall(
  value: unknown,
  expectedSequence: number,
  safeAddress: string,
  deployerAddress: string
): SimulationCall {
  const candidate = record(value);
  exactKeys(candidate, ['data', 'from', 'gasUsed', 'senderRole', 'sequence', 'step', 'to', 'transactionHash', 'value']);
  if (
    candidate.sequence !== expectedSequence ||
    (candidate.senderRole !== 'safe' && candidate.senderRole !== 'deployer') ||
    (candidate.senderRole === 'safe' &&
      (candidate.from !== safeAddress || typeof candidate.to !== 'string' || !ADDRESS_PATTERN.test(candidate.to))) ||
    (candidate.senderRole === 'deployer' &&
      (candidate.from !== deployerAddress ||
        (candidate.to !== null && (typeof candidate.to !== 'string' || !ADDRESS_PATTERN.test(candidate.to))))) ||
    typeof candidate.data !== 'string' ||
    !HEX_PATTERN.test(candidate.data) ||
    (candidate.data.length - 2) / 2 > MAX_CALLDATA_BYTES ||
    typeof candidate.step !== 'string' ||
    candidate.step.length < 1 ||
    candidate.step.length > 512 ||
    typeof candidate.transactionHash !== 'string' ||
    !HASH_PATTERN.test(candidate.transactionHash)
  ) {
    throw new Error('PREVIEW_REJECTED');
  }
  return Object.freeze({
    data: candidate.data as `0x${string}`,
    from: candidate.from as `0x${string}`,
    gasUsed: uint(candidate.gasUsed),
    senderRole: candidate.senderRole,
    sequence: candidate.sequence,
    step: candidate.step,
    to: candidate.to as `0x${string}` | null,
    transactionHash: candidate.transactionHash as `0x${string}`,
    value: uint(candidate.value),
  });
}

/**
 * Parses and structurally validates bounded, review-only local Cannon evidence
 * for one source commit and Safe. This does not authenticate or recompute the
 * simulation and therefore must never authorize signing.
 */
export function parseReyaPreview(
  input: string,
  expected: {
    commit: string;
    previousDeployCid?: string;
    safeAddress: `0x${string}`;
  }
): ReyaPreview {
  if (input.length < 2 || input.length > 16 * 1024 * 1024) {
    throw new Error('PREVIEW_REJECTED');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new Error('PREVIEW_REJECTED');
  }
  const value = record(decoded);
  exactKeys(value, [
    'cannon',
    'chainId',
    'commit',
    'deployerAddress',
    'deployerPrerequisites',
    'deployerStartingNonce',
    'previousDeployCid',
    'qaEvidence',
    'safeAddress',
    'safeProposalCalls',
    'schemaVersion',
    'simulationTransactions',
    'type',
  ]);
  const cannon = record(value.cannon);
  const qaEvidence = record(value.qaEvidence);
  const deployerAddress = String(value.deployerAddress);
  if (
    value.schemaVersion !== 2 ||
    value.type !== 'reya-cannon-read-only-preview' ||
    value.chainId !== 1729 ||
    value.commit !== expected.commit ||
    !COMMIT_PATTERN.test(expected.commit) ||
    value.safeAddress !== expected.safeAddress ||
    !ADDRESS_PATTERN.test(deployerAddress) ||
    deployerAddress === expected.safeAddress ||
    !UINT_PATTERN.test(String(value.deployerStartingNonce)) ||
    !CID_PATTERN.test(String(value.previousDeployCid)) ||
    (expected.previousDeployCid !== undefined && value.previousDeployCid !== expected.previousDeployCid) ||
    Reflect.ownKeys(cannon).length !== 2 ||
    cannon.stateFormatVersion !== 7 ||
    cannon.version !== '2.26.1' ||
    !['interactive-current-state', 'non-signable-local-qa'].includes(String(qaEvidence.mode)) ||
    typeof qaEvidence.bundleSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(qaEvidence.bundleSha256) ||
    !Array.isArray(value.deployerPrerequisites) ||
    !Array.isArray(value.safeProposalCalls) ||
    !Array.isArray(value.simulationTransactions) ||
    value.simulationTransactions.length < 1 ||
    value.simulationTransactions.length > MAX_CALLS ||
    value.safeProposalCalls.length < 1 ||
    value.safeProposalCalls.length > MAX_CALLS
  ) {
    throw new Error('PREVIEW_REJECTED');
  }
  const simulation = value.simulationTransactions.map((item, index) =>
    simulationCall(item, index, expected.safeAddress, deployerAddress)
  );
  const calls = simulation.filter((item): item is ReyaPreviewCall => item.senderRole === 'safe');
  const prerequisites = simulation.filter((item) => item.senderRole === 'deployer');
  if (
    JSON.stringify(calls) !== JSON.stringify(value.safeProposalCalls) ||
    JSON.stringify(prerequisites) !== JSON.stringify(value.deployerPrerequisites) ||
    new Set(calls.map(({ transactionHash }) => transactionHash)).size !== calls.length ||
    new Set(simulation.map(({ transactionHash }) => transactionHash)).size !== simulation.length
  ) {
    throw new Error('PREVIEW_REJECTED');
  }

  return Object.freeze({
    commit: expected.commit,
    deployerPrerequisiteCount: prerequisites.length,
    previousDeployCid: String(value.previousDeployCid),
    safeAddress: expected.safeAddress,
    safeProposalCalls: Object.freeze(calls),
    sourceBundleSha256: qaEvidence.bundleSha256,
  });
}

/**
 * Converts a verified preview into one Safe delegatecall at the observed nonce.
 * Previews with deployer prerequisites are never stageable.
 */
export function makeStageableSafeTransaction(preview: ReyaPreview, nonce: number): SafeTransaction {
  if (preview.deployerPrerequisiteCount !== 0 || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error('PREVIEW_NOT_STAGEABLE');
  }
  const calls = preview.safeProposalCalls.map(({ data, to, value }) => ({
    callData: data,
    requireSuccess: true,
    target: to,
    value: BigInt(value),
  }));
  const aggregate = Object.freeze({
    data: encodeFunctionData({
      abi: MulticallABI,
      args: [calls],
      functionName: 'aggregate3Value',
    }),
    operation: '1',
    to: MULTICALL_ADDRESS,
    value: calls.reduce((total, item) => total + item.value, 0n).toString(),
  });
  const safeTxGas = preview.safeProposalCalls.reduce((total, item) => total + BigInt(item.gasUsed), 0n).toString();

  return Object.freeze({
    _nonce: nonce,
    baseGas: '0',
    data: aggregate.data,
    gasPrice: '0',
    gasToken: zeroAddress,
    operation: aggregate.operation,
    refundReceiver: preview.safeAddress,
    safeTxGas,
    to: aggregate.to,
    value: aggregate.value,
  });
}
