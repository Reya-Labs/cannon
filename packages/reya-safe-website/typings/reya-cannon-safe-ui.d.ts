declare module '@reya/cannon-safe-ui/read-only' {
  export const ARTIFACT_CAT_PATH: '/artifacts/api/v0/cat';
  export const OP_REGISTRY_RESOLVE_PATH: '/registry/op/resolve';
  export const REYA_OMNIBUS_LATEST: 'reya-omnibus:latest@main';
  export const RPC_ROUTE_PATH: '/rpc/1729';
  export const SOURCE_ROUTE_PREFIX: '/source/reya-deployments/';

  export function isReyaOmnibusPackageRef(value: unknown): boolean;

  export class ReyaReadClientError extends Error {
    code: string;
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
    registry: {
      resolve(input: { chainId: 1729; packageRef: string }): Promise<{
        chainId: 1729;
        cid: string;
        deployUrl: string;
        mutability: '' | 'tag' | 'version';
        packageRef: string;
        registryAddress: string;
        registryChainId: 10;
      }>;
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
}

declare module '@reya/cannon-safe-ui/artifact-loader' {
  export function createReadOnlyArtifactLoader(options: {
    maximumBytes?: number;
    readArtifact: (cid: string) => Promise<Uint8Array>;
  }): {
    read(url: string): Promise<unknown>;
  };
}

declare module '@reya/cannon-safe-ui/safe-review' {
  export function prepareReyaSafeTransaction(input: { safeAddress: `0x${string}`; txn: Record<string, unknown> }): {
    safeTxHash: `0x${string}`;
    txn: Readonly<Record<string, unknown>>;
    typedData: Readonly<Record<string, unknown>>;
  };
}

declare module '@reya/cannon-safe-ui/clients' {
  export type ReyaSafeTransaction = Readonly<{
    _nonce: number;
    baseGas: string;
    data: `0x${string}`;
    gasPrice: string;
    gasToken: `0x${string}`;
    operation: string;
    refundReceiver: `0x${string}`;
    safeTxGas: string;
    to: `0x${string}`;
    value: string;
  }>;

  export function createReyaSafeSigningClient(options: {
    safeAddress: `0x${string}`;
    signTypedData: (request: Readonly<Record<string, unknown>>) => Promise<string>;
  }): {
    prepare(input: { txn: ReyaSafeTransaction }): {
      safeTxHash: `0x${string}`;
      txn: ReyaSafeTransaction;
      typedData: Readonly<Record<string, unknown>>;
    };
    sign(input: { ownerAddress: `0x${string}`; prepared: Readonly<Record<string, unknown>> }): Promise<{
      safeTxHash: `0x${string}`;
      signature: `0x${string}`;
      signer: `0x${string}`;
    }>;
  };

  export function createReyaStagingClient(options: {
    fetchImpl?: typeof fetch;
    safeAddress: `0x${string}`;
    serviceOrigin: string;
  }): {
    current(): Promise<{
      createdAt: number;
      sigs: readonly `0x${string}`[];
      txn: ReyaSafeTransaction;
      updatedAt: number;
    } | null>;
    submitSignature(input: { signature: `0x${string}`; txn: ReyaSafeTransaction }): Promise<{
      created: boolean;
      proposal: {
        createdAt: number;
        sigs: readonly `0x${string}`[];
        txn: ReyaSafeTransaction;
        updatedAt: number;
      };
    }>;
  };
}
