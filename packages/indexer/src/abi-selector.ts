import * as viem from 'viem';

type AbiFunctionOrError = Extract<viem.Abi[number], { type: 'function' | 'error' }>;

/**
 * Converts a viem function/error ABI item into the canonical text signature and
 * four-byte Keccak selector stored by the registry index.
 */
export function canonicalAbiSelector(item: AbiFunctionOrError): {
  selector: `0x${string}`;
  signature: string;
} {
  // viem's function formatter prefixes AbiError values with "error ". Redis
  // stores the canonical text signature because that is what is hashed on-chain.
  const formatted = viem.toFunctionSignature(item as viem.AbiFunction);
  const signature = item.type === 'error' ? formatted.replace(/^error\s+/, '') : formatted;

  return {
    selector: viem.toFunctionSelector(signature),
    signature,
  };
}
