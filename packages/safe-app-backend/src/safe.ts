import { concat, getAddress, hexToBytes, recoverAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import SafeABI from './abi/Safe.json';
import { HttpError } from './errors';
import type { SafeClient, SafeTransaction, VerifiedSignature } from './types';

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_CALLDATA_BYTES = 512 * 1024;
const MAX_SIGNATURES = 100;

const uintString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => {
    try {
      return BigInt(value) <= MAX_UINT256;
    } catch {
      return false;
    }
  }, 'must fit uint256');

const address = z
  .string()
  .refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value), 'invalid address')
  .transform((value) => getAddress(value));

const hexData = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/, 'must be even-length hex bytes')
  .refine((value) => (value.length - 2) / 2 <= MAX_CALLDATA_BYTES, 'calldata is too large')
  .transform((value) => value as Hex);

const signature = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte signature')
  .transform((value) => value as Hex);

const safeDigest = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte Safe transaction hash')
  .transform((value) => value.toLowerCase() as Hex);

export const stageRequestSchema = z
  .object({
    attestation: z
      .object({
        format: z.string().min(1).max(64),
        payload: z
          .string()
          .min(1)
          .max(128 * 1024),
        signature: z
          .string()
          .min(1)
          .max(16 * 1024),
      })
      .strict()
      .optional(),
    createdAt: z.number().optional(),
    sigs: z.array(signature).min(1, 'at least one signature is required').max(MAX_SIGNATURES),
    txn: z
      .object({
        _nonce: z.number().int().nonnegative().safe(),
        baseGas: uintString,
        data: hexData,
        gasPrice: uintString,
        gasToken: address,
        operation: z.enum(['0', '1']),
        refundReceiver: address,
        safeTxGas: uintString,
        to: address,
        value: uintString,
      })
      .strict(),
    updatedAt: z.number().optional(),
  })
  .strict();

export const supersedeRequestSchema = z
  .object({
    expectedDigest: safeDigest,
    reason: z.string().trim().min(8).max(500),
  })
  .strict();

export type StageRequest = z.infer<typeof stageRequestSchema>;

export async function getSafeDigest(client: SafeClient, safeAddress: Address, txn: SafeTransaction): Promise<Hex> {
  return (await client.readContract({
    abi: SafeABI,
    address: safeAddress,
    functionName: 'getTransactionHash',
    args: [
      txn.to,
      txn.value,
      txn.data,
      txn.operation,
      txn.safeTxGas,
      txn.baseGas,
      txn.gasPrice,
      txn.gasToken,
      txn.refundReceiver,
      txn._nonce,
    ],
  })) as Hex;
}

export async function getSafeNonce(client: SafeClient, safeAddress: Address): Promise<number> {
  const nonce = (await client.readContract({
    abi: SafeABI,
    address: safeAddress,
    functionName: 'nonce',
  })) as bigint;
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(503, 'safe_nonce_unsupported', 'Safe nonce exceeds the supported integer range');
  }
  return Number(nonce);
}

export async function getSafeOwners(client: SafeClient, safeAddress: Address): Promise<Set<string>> {
  const owners = (await client.readContract({
    abi: SafeABI,
    address: safeAddress,
    functionName: 'getOwners',
  })) as Address[];
  return new Set(owners.map((owner) => owner.toLowerCase()));
}

export async function validateSignatures(
  client: SafeClient,
  safeAddress: Address,
  digest: Hex,
  signatures: Hex[]
): Promise<VerifiedSignature[]> {
  const owners = await getSafeOwners(client, safeAddress);
  const recovered = new Map<string, VerifiedSignature>();

  for (const submittedSignature of signatures) {
    const bytes = hexToBytes(submittedSignature);
    const version = bytes[64];
    if (version !== 27 && version !== 28) {
      throw new HttpError(
        400,
        'unsupported_signature_type',
        'only 65-byte EIP-712 EOA Safe signatures with v=27 or v=28 are supported'
      );
    }

    let owner: Address;
    try {
      owner = getAddress(await recoverAddress({ hash: digest, signature: submittedSignature }));
    } catch {
      throw new HttpError(400, 'invalid_signature', 'signature recovery failed');
    }

    const ownerKey = owner.toLowerCase();
    if (!owners.has(ownerKey)) {
      throw new HttpError(400, 'non_owner_signature', `signature recovered to non-owner ${owner}`);
    }

    const existing = recovered.get(ownerKey);
    if (existing && existing.signature !== submittedSignature) {
      throw new HttpError(409, 'duplicate_owner_signature', `multiple signatures were supplied for owner ${owner}`);
    }
    recovered.set(ownerKey, { owner, signature: submittedSignature });
  }

  const sorted = Array.from(recovered.values()).sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));

  try {
    await client.readContract({
      abi: SafeABI,
      address: safeAddress,
      functionName: 'checkNSignatures',
      args: [digest, '0x', concat(sorted.map(({ signature: value }) => value)), sorted.length],
    });
  } catch {
    throw new HttpError(400, 'invalid_signature', 'Safe rejected the submitted signatures');
  }

  return sorted;
}

export async function filterCurrentOwnerSignatures(
  client: SafeClient,
  safeAddress: Address,
  digest: Hex,
  signatures: Hex[]
): Promise<Hex[]> {
  const owners = await getSafeOwners(client, safeAddress);
  const current: Array<{ owner: Address; signature: Hex }> = [];

  for (const submittedSignature of signatures) {
    try {
      const owner = getAddress(await recoverAddress({ hash: digest, signature: submittedSignature }));
      if (owners.has(owner.toLowerCase())) current.push({ owner, signature: submittedSignature });
    } catch {
      throw new HttpError(503, 'persistence_corrupt', 'a persisted signature cannot be recovered');
    }
  }

  return current
    .sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()))
    .map(({ signature: value }) => value);
}

export async function checkSafeReadiness(
  client: SafeClient,
  safeAddress: Address,
  expectedChainId: number,
  maxBlockAgeSeconds: number,
  nowMs = Date.now()
): Promise<void> {
  const [chainId, bytecode, owners, threshold, latestBlock] = await Promise.all([
    client.getChainId(),
    client.getBytecode({ address: safeAddress }),
    client.readContract({ abi: SafeABI, address: safeAddress, functionName: 'getOwners' }) as Promise<Address[]>,
    client.readContract({ abi: SafeABI, address: safeAddress, functionName: 'getThreshold' }) as Promise<bigint>,
    client.getBlock({ blockTag: 'latest' }),
  ]);

  if (chainId !== expectedChainId) {
    throw new Error(`RPC chain mismatch: expected ${expectedChainId}, received ${chainId}`);
  }
  if (!bytecode || bytecode === '0x') throw new Error(`configured Safe ${safeAddress} has no bytecode`);
  if (owners.length === 0 || threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error(`configured Safe ${safeAddress} has invalid owner or threshold state`);
  }

  const blockAge = Math.floor(nowMs / 1000) - Number(latestBlock.timestamp);
  if (blockAge < -30 || blockAge > maxBlockAgeSeconds) {
    throw new Error(`RPC latest block is outside the freshness window (${blockAge}s)`);
  }
}
