import { SafeTransaction } from '@cannon/types/SafeTransaction';
import { ResolvedArtifactInput, ResolvedDeploymentSource } from './deployment-input';
import { ReyaDecodedCall, ReyaPreview } from './preview';

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export type ReyaReviewExport = Readonly<{
  authorization: 'review-only';
  chainId: 1729;
  deployment: Readonly<{
    cannonfileUrl: string | null;
    inputKind: 'cannonfile' | 'cid';
    partialDeploymentCid: string | null;
  }>;
  previousPackage: Readonly<{
    cid: string;
    reference: string;
  }>;
  safe: Readonly<{
    address: `0x${string}`;
    nonce: number;
    transaction: SafeTransaction;
    transactionHash: `0x${string}`;
  }>;
  schemaVersion: 2;
  simulation: Readonly<{
    deployerPrerequisiteCount: number;
    mode: 'automatic-current-state-local-build';
    orderedCalls: readonly Readonly<{
      calldata: `0x${string}`;
      decodedCalldata: ReyaDecodedCall | null;
      gasUsed: string;
      sequence: number;
      simulationTransactionHash: `0x${string}`;
      step: string;
      target: `0x${string}`;
      value: string;
    }>[];
  }>;
  source: Readonly<{
    bundleSha256: string;
    commit: string;
    repository: 'Reya-Labs/reya-deployments';
  }>;
  type: 'reya-cannon-safe-review';
  warning: string;
}>;

export function createReviewExport(input: {
  deployment: ResolvedDeploymentSource;
  preview: ReyaPreview;
  previous: ResolvedArtifactInput;
  safeTxHash: `0x${string}`;
  transaction: SafeTransaction;
}): Readonly<{
  filename: string;
  json: string;
  value: ReyaReviewExport;
}> {
  if (
    !HASH_PATTERN.test(input.safeTxHash) ||
    input.transaction._nonce < 0 ||
    !Number.isSafeInteger(input.transaction._nonce) ||
    input.preview.safeAddress !== input.transaction.refundReceiver
  ) {
    throw new Error('REVIEW_EXPORT_REJECTED');
  }

  const value: ReyaReviewExport = Object.freeze({
    authorization: 'review-only',
    chainId: 1729,
    deployment: Object.freeze({
      cannonfileUrl: input.deployment.cannonfileUrl ?? input.deployment.descriptor?.cannonfileUrl ?? null,
      inputKind: input.deployment.inputKind,
      partialDeploymentCid: input.preview.partialDeployCid,
    }),
    previousPackage: Object.freeze({
      cid: input.preview.previousPackageCid,
      reference: input.previous.descriptor.packageRef,
    }),
    safe: Object.freeze({
      address: input.preview.safeAddress,
      nonce: input.transaction._nonce,
      transaction: input.transaction,
      transactionHash: input.safeTxHash,
    }),
    schemaVersion: 2,
    simulation: Object.freeze({
      deployerPrerequisiteCount: input.preview.deployerPrerequisiteCount,
      mode: 'automatic-current-state-local-build',
      orderedCalls: Object.freeze(
        input.preview.safeProposalCalls.map((call) =>
          Object.freeze({
            calldata: call.data,
            decodedCalldata: call.decoded,
            gasUsed: call.gasUsed,
            sequence: call.sequence,
            simulationTransactionHash: call.transactionHash,
            step: call.step,
            target: call.to,
            value: call.value,
          })
        )
      ),
    }),
    source: Object.freeze({
      bundleSha256: input.preview.sourceBundleSha256,
      commit: input.preview.commit,
      repository: 'Reya-Labs/reya-deployments',
    }),
    type: 'reya-cannon-safe-review',
    warning: 'Review snapshot only. Signing and staging must recompute the preview and current Safe state.',
  });

  return Object.freeze({
    filename: `reya-cannon-safe-1729-${input.transaction._nonce}-` + `${input.safeTxHash.slice(2, 14)}.json`,
    json: `${JSON.stringify(value, null, 2)}\n`,
    value,
  });
}
