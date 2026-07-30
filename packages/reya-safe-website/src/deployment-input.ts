import { createReadOnlyArtifactLoader } from '@reya/cannon-safe-ui/artifact-loader';
import { isReyaOmnibusPackageRef, REYA_OMNIBUS_LATEST } from '@reya/cannon-safe-ui/read-only';

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CANNONFILE_PATH = 'packages/tomls/src/omnibus/reya_network.toml';
const SOURCE_REPOSITORY = 'https://github.com/Reya-Labs/reya-deployments';
const CANNONFILE_URL_PATTERN =
  /^https:\/\/github\.com\/Reya-Labs\/reya-deployments\/blob\/([0-9a-f]{40})\/packages\/tomls\/src\/omnibus\/reya_network\.toml$/;

type ArtifactClient = Readonly<{
  cat(input: { cid: string }): Promise<Uint8Array>;
}>;

type RegistryClient = Readonly<{
  resolve(input: { chainId: 1729; packageRef: string }): Promise<
    Readonly<{
      cid: string;
      mutability: '' | 'tag' | 'version';
      packageRef: string;
    }>
  >;
}>;

export type DeploymentDescriptor = Readonly<{
  cannonfileUrl: string | null;
  cid: string;
  packageRef: string;
  sourceCommit: string | null;
  status: 'complete' | 'partial';
  version: string;
}>;

export type ResolvedArtifactInput = Readonly<{
  cid: string;
  descriptor: DeploymentDescriptor;
  inputKind: 'cid' | 'op-registry';
}>;

export type ResolvedDeploymentSource =
  | Readonly<{
      cannonfileUrl: string;
      cid: null;
      descriptor: null;
      inputKind: 'cannonfile';
      sourceCommit: string;
    }>
  | Readonly<{
      cannonfileUrl: null;
      cid: string;
      descriptor: DeploymentDescriptor;
      inputKind: 'cid';
      sourceCommit: string;
    }>;

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error('ARTIFACT_SCHEMA_REJECTED');
  }
  return value as Record<string, unknown>;
}

export function normalizeArtifactCid(value: string): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.startsWith('ipfs://') ? value.slice('ipfs://'.length) : value;
  return CID_PATTERN.test(candidate) ? candidate : null;
}

export function immutableCannonfileUrl(commit: string): string {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error('SOURCE_COMMIT_INVALID');
  }
  return `${SOURCE_REPOSITORY}/blob/${commit}/${CANNONFILE_PATH}`;
}

export function immutableCannonfileCommit(value: string): string | null {
  if (typeof value !== 'string') return null;
  return CANNONFILE_URL_PATTERN.exec(value)?.[1] ?? null;
}

export async function loadDeploymentDescriptor(
  artifacts: ArtifactClient,
  cid: string,
  { requireComplete = false }: { requireComplete?: boolean } = {}
): Promise<DeploymentDescriptor> {
  if (normalizeArtifactCid(cid) !== cid) {
    throw new Error('ARTIFACT_CID_INVALID');
  }
  const loader = createReadOnlyArtifactLoader({
    readArtifact: (requestedCid: string) => artifacts.cat({ cid: requestedCid }),
  });
  let deployment: Record<string, unknown>;
  try {
    deployment = record(await loader.read(`ipfs://${cid}`));
  } catch {
    throw new Error('ARTIFACT_UNAVAILABLE');
  }
  const definition = record(deployment.def);
  const status = deployment.status;
  const version = definition.version;
  if (
    deployment.chainId !== 1729 ||
    (status !== 'complete' && status !== 'partial') ||
    (requireComplete && status !== 'complete') ||
    definition.name !== 'reya-omnibus' ||
    definition.preset !== 'main' ||
    typeof version !== 'string' ||
    version.length > 32 ||
    !VERSION_PATTERN.test(version)
  ) {
    throw new Error('ARTIFACT_SCHEMA_REJECTED');
  }
  let sourceCommit: string | null = null;
  let cannonfileUrl: string | null = null;
  if (status === 'partial') {
    const metadata = record(deployment.meta);
    if (
      metadata.gitUrl !== SOURCE_REPOSITORY ||
      typeof metadata.commitHash !== 'string' ||
      !COMMIT_PATTERN.test(metadata.commitHash)
    ) {
      throw new Error('ARTIFACT_PROVENANCE_REJECTED');
    }
    sourceCommit = metadata.commitHash;
    cannonfileUrl = immutableCannonfileUrl(sourceCommit);
  }
  return Object.freeze({
    cannonfileUrl,
    cid,
    packageRef: `reya-omnibus:${version}@main`,
    sourceCommit,
    status,
    version,
  });
}

export async function resolveArtifactInput({
  artifacts,
  input,
  registry,
  requireComplete = false,
}: {
  artifacts: ArtifactClient;
  input: string;
  registry: RegistryClient;
  requireComplete?: boolean;
}): Promise<ResolvedArtifactInput> {
  const cid = normalizeArtifactCid(input);
  let requestedPackageRef: string | null = null;
  let resolvedMutability: '' | 'tag' | 'version' | null = null;
  let resolvedCid = cid;
  let inputKind: 'cid' | 'op-registry' = 'cid';
  if (resolvedCid === null) {
    if (!isReyaOmnibusPackageRef(input)) {
      throw new Error('PACKAGE_OR_CID_INVALID');
    }
    requestedPackageRef = input;
    inputKind = 'op-registry';
    let resolved;
    try {
      resolved = await registry.resolve({
        chainId: 1729,
        packageRef: input,
      });
    } catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'OP_ALIAS_UNKNOWN') {
        throw new Error('OP_ALIAS_UNKNOWN');
      }
      throw new Error('OP_REGISTRY_UNAVAILABLE');
    }
    resolvedCid = resolved.cid;
    resolvedMutability = resolved.mutability;
  }
  const descriptor = await loadDeploymentDescriptor(artifacts, resolvedCid, { requireComplete });
  if (
    requestedPackageRef !== null &&
    ((requestedPackageRef === REYA_OMNIBUS_LATEST && resolvedMutability !== 'tag') ||
      (requestedPackageRef !== REYA_OMNIBUS_LATEST && resolvedMutability !== 'version'))
  ) {
    throw new Error('OP_ALIAS_MUTABILITY_MISMATCH');
  }
  if (
    requestedPackageRef !== null &&
    requestedPackageRef !== REYA_OMNIBUS_LATEST &&
    descriptor.packageRef !== requestedPackageRef
  ) {
    throw new Error('OP_ALIAS_ARTIFACT_MISMATCH');
  }
  return Object.freeze({
    cid: resolvedCid,
    descriptor,
    inputKind,
  });
}

/**
 * Resolves only the two deployment-source modes supported by Cannon's queue
 * flow. Package aliases belong in the separate previous-package input.
 */
export async function resolveDeploymentSourceInput({
  artifacts,
  comparisonCannonfileUrl = '',
  expectedCommit,
  input,
}: {
  artifacts: ArtifactClient;
  comparisonCannonfileUrl?: string;
  expectedCommit: string;
  input: string;
}): Promise<ResolvedDeploymentSource> {
  const cannonfileUrl = immutableCannonfileUrl(expectedCommit);
  if (input === cannonfileUrl) {
    return Object.freeze({
      cannonfileUrl,
      cid: null,
      descriptor: null,
      inputKind: 'cannonfile',
      sourceCommit: expectedCommit,
    });
  }
  const cid = normalizeArtifactCid(input);
  if (cid === null) {
    throw new Error('DEPLOYMENT_SOURCE_INVALID');
  }
  const descriptor = await loadDeploymentDescriptor(artifacts, cid);
  if (descriptor.status !== 'partial' || descriptor.sourceCommit === null || descriptor.cannonfileUrl === null) {
    throw new Error('DEPLOYMENT_SOURCE_REQUIRES_PARTIAL_ARTIFACT');
  }
  if (
    comparisonCannonfileUrl !== '' &&
    (immutableCannonfileCommit(comparisonCannonfileUrl) !== descriptor.sourceCommit ||
      comparisonCannonfileUrl !== descriptor.cannonfileUrl)
  ) {
    throw new Error('CANNONFILE_PROVENANCE_MISMATCH');
  }
  return Object.freeze({
    cannonfileUrl: null,
    cid,
    descriptor,
    inputKind: 'cid',
    sourceCommit: descriptor.sourceCommit,
  });
}
