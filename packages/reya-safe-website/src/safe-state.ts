import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress } from 'viem';

const SAFE_READ_ABI = [
  {
    inputs: [],
    name: 'nonce',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

type RpcClient = {
  read(input: { method: string; params: unknown[] }): Promise<unknown>;
};

async function safeRead(rpc: RpcClient, safeAddress: `0x${string}`, functionName: 'getOwners' | 'getThreshold' | 'nonce') {
  const data = encodeFunctionData({
    abi: SAFE_READ_ABI,
    functionName,
  });
  const result = await rpc.read({
    method: 'eth_call',
    params: [{ data, to: safeAddress }, 'latest'],
  });
  if (typeof result !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) {
    throw new Error('SAFE_READ_REJECTED');
  }
  return decodeFunctionResult({
    abi: SAFE_READ_ABI,
    data: result as `0x${string}`,
    functionName,
  });
}

export async function readReyaSafeState(rpc: RpcClient, safeAddress: `0x${string}`) {
  const [chainId, code, nonce, owners, threshold] = await Promise.all([
    rpc.read({ method: 'eth_chainId', params: [] }),
    rpc.read({
      method: 'eth_getCode',
      params: [safeAddress, 'latest'],
    }),
    safeRead(rpc, safeAddress, 'nonce'),
    safeRead(rpc, safeAddress, 'getOwners'),
    safeRead(rpc, safeAddress, 'getThreshold'),
  ]);
  if (
    chainId !== '0x6c1' ||
    typeof code !== 'string' ||
    !/^0x[0-9a-fA-F]+$/.test(code) ||
    code === '0x' ||
    typeof nonce !== 'bigint' ||
    nonce < 0n ||
    nonce > BigInt(Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(owners) ||
    owners.length < 1 ||
    owners.length > 100 ||
    owners.some((owner) => !isAddress(owner)) ||
    new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length ||
    typeof threshold !== 'bigint' ||
    threshold < 1n ||
    threshold > BigInt(owners.length)
  ) {
    throw new Error('SAFE_STATE_REJECTED');
  }

  return Object.freeze({
    nonce: Number(nonce),
    owners: Object.freeze(owners.map((owner) => getAddress(owner).toLowerCase()).sort()),
    threshold: Number(threshold),
  });
}
