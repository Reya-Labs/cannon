declare module '@reya/cannon-safe-ui/clients' {
  export class ReyaReadClientError extends Error {
    code: string;
  }

  export class ReyaStagingServiceError extends ReyaReadClientError {
    httpStatus: number;
    serviceCode: string;
  }

  export function createReyaReadOnlyClients(options: {
    fetchImpl?: typeof fetch;
    serviceOrigin: string;
    verifyAbiSelector: (signature: string, selector: string) => boolean | Promise<boolean>;
    verifyArtifactCid: (bytes: Uint8Array) => string | Promise<string>;
  }): {
    artifacts: {
      cat(input: { cid: string }): Promise<Uint8Array>;
    };
    chainId: 1729;
    rpc: {
      read(input: { method: string; params: unknown[] }): Promise<unknown>;
    };
    serviceOrigin: string;
    source: {
      bundle(input: { commit: string }): Promise<{
        bundleSha256: string;
        commit: string;
        files: readonly unknown[];
      }>;
    };
  };

  export function createReyaStagingClient(options: {
    deadlineMs?: number;
    fetchImpl?: typeof fetch;
    safeAddress: `0x${string}`;
    serviceOrigin: string;
  }): {
    chainId: 1729;
    current(): Promise<null | {
      createdAt: number;
      sigs: readonly string[];
      txn: Record<string, unknown>;
      updatedAt: number;
    }>;
    safeAddress: `0x${string}`;
    submitSignature(input: { signature: string; txn: Record<string, unknown> }): Promise<{
      created: boolean;
      proposal: {
        createdAt: number;
        sigs: readonly string[];
        txn: Record<string, unknown>;
        updatedAt: number;
      };
    }>;
  };

  export function createReyaSafeSigningClient(options: {
    safeAddress: `0x${string}`;
    signTypedData: (value: unknown) => Promise<string>;
  }): {
    prepare(input: { txn: Record<string, unknown> }): {
      safeTxHash: `0x${string}`;
      txn: Record<string, unknown>;
      typedData: unknown;
    };
    sign(input: { ownerAddress: `0x${string}`; prepared: object }): Promise<{
      safeTxHash: `0x${string}`;
      signature: `0x${string}`;
      signer: `0x${string}`;
    }>;
  };
}
