import type { Address, Hex } from 'viem';

export type SafeTransaction = {
  to: Address;
  value: string;
  data: Hex;
  operation: '0' | '1';
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  _nonce: number;
};

export type StagedTransaction = {
  txn: SafeTransaction;
  sigs: Hex[];
  createdAt: number;
  updatedAt: number;
};

export type ActorRole = 'proposer' | 'signer' | 'operator';

export type Actor = {
  subject: string;
  roles: Set<ActorRole>;
};

export type DetachedAttestation = {
  format: string;
  payload: string;
  signature: string;
};

export type AdmissionInput = {
  actor: Actor;
  attestation?: DetachedAttestation;
  chainId: number;
  safeAddress: Address;
  safeTxHash: Hex;
  txn: SafeTransaction;
};

export type Admission = {
  id: string;
};

export interface ProposalAdmissionVerifier {
  verify(input: AdmissionInput): Promise<Admission>;
}

export interface SafeClient {
  getBlock(parameters?: { blockTag?: 'latest' }): Promise<{ timestamp: bigint }>;
  getBytecode(parameters: { address: Address }): Promise<Hex | undefined>;
  getChainId(): Promise<number>;
  readContract(parameters: Record<string, unknown>): Promise<unknown>;
}

export type ProviderRegistry = Map<number, SafeClient>;

export type StoredProposal = {
  admissionId: string;
  createdAt: number;
  digest: Hex;
  expiresAt: number;
  sigs: Hex[];
  status: 'active' | 'expired' | 'stale' | 'superseded';
  txn: SafeTransaction;
  updatedAt: number;
};

export type VerifiedSignature = {
  owner: Address;
  signature: Hex;
};
