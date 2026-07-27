import { inflateSync } from 'node:zlib';
import { getContentCID, getDeploymentImports } from '@usecannon/builder';
import type { DeploymentInfo } from '@usecannon/builder';
import type { ArtifactFacadeClient } from './artifact-client';
import type { ArtifactWorkerConfig } from './worker-config';

export interface ArtifactClosure {
  artifacts: Map<string, Buffer>;
  packageCids: Set<string>;
  inflatedBytes: number;
}

export interface ClosureDifference {
  missing: string[];
  extra: string[];
}

function normalizeCid(value: unknown): string {
  if (typeof value !== 'string') throw new Error('artifact closure contains an invalid CID');
  const trimmed = value.trim();
  const cid = trimmed.startsWith('ipfs://') ? trimmed.slice('ipfs://'.length) : trimmed;
  if (cid.length !== 46 || !/^[a-zA-Z0-9]+$/.test(cid)) {
    throw new Error('artifact closure contains an invalid CID');
  }
  return cid;
}

function asSet(values: Iterable<string>) {
  return new Set(values);
}

export function reconcileClosure(expectedValues: Iterable<string>, actualValues: Iterable<string>): ClosureDifference {
  const expected = asSet(expectedValues);
  const actual = asSet(actualValues);

  return {
    missing: [...expected].filter((cid) => !actual.has(cid)).sort(),
    extra: [...actual].filter((cid) => !expected.has(cid)).sort(),
  };
}

export function assertExactClosure(expected: Iterable<string>, actual: Iterable<string>) {
  const difference = reconcileClosure(expected, actual);
  if (difference.missing.length || difference.extra.length) {
    throw new Error(
      `artifact closure reconciliation failed: ${difference.missing.length} missing, ${difference.extra.length} extra`
    );
  }
}

function parseDeployment(data: Buffer, config: ArtifactWorkerConfig): { deployment: DeploymentInfo; inflatedBytes: number } {
  if (data.length > config.ARTIFACT_MAX_COMPRESSED_BYTES) {
    throw new Error('compressed package exceeds its per-node limit');
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(data, { maxOutputLength: config.ARTIFACT_MAX_INFLATED_BYTES });
  } catch {
    throw new Error('package is invalid or exceeds its inflated per-node limit');
  }

  let deployment: unknown;
  try {
    deployment = JSON.parse(inflated.toString('utf8'));
  } catch {
    throw new Error('package contains invalid JSON');
  }

  if (
    !deployment ||
    typeof deployment !== 'object' ||
    Array.isArray(deployment) ||
    typeof (deployment as Partial<DeploymentInfo>).miscUrl !== 'string' ||
    !(deployment as Partial<DeploymentInfo>).state ||
    typeof (deployment as Partial<DeploymentInfo>).state !== 'object'
  ) {
    throw new Error('artifact is not a Cannon deployment package');
  }

  return { deployment: deployment as DeploymentInfo, inflatedBytes: inflated.length };
}

async function readVerified(client: ArtifactFacadeClient, cid: string, config: ArtifactWorkerConfig): Promise<Buffer> {
  const data = await client.read(cid);
  if (data.length > config.ARTIFACT_MAX_NODE_BYTES) {
    throw new Error('artifact exceeds its per-node limit');
  }

  const actualCid = await getContentCID(data);
  if (actualCid !== cid) {
    throw new Error('artifact source returned bytes that do not match the requested CID');
  }
  return data;
}

export async function discoverArtifactClosure(
  client: ArtifactFacadeClient,
  rootCidValue: string,
  metadataCidValues: string[],
  config: ArtifactWorkerConfig
): Promise<ArtifactClosure> {
  const rootCid = normalizeCid(rootCidValue);
  const artifacts = new Map<string, Buffer>();
  const expectedCids = new Set<string>();
  const packageCids = new Set<string>();
  const packageQueue: string[] = [];
  let closureBytes = 0;
  let closureInflatedBytes = 0;

  function addExpected(cidValue: unknown, packageNode: boolean) {
    const cid = normalizeCid(cidValue);
    if (!expectedCids.has(cid)) {
      expectedCids.add(cid);
      if (expectedCids.size > config.ARTIFACT_MAX_CLOSURE_NODES) {
        throw new Error('artifact closure exceeds its node limit');
      }
    }
    if (packageNode && !packageCids.has(cid)) {
      packageCids.add(cid);
      packageQueue.push(cid);
    }
    return cid;
  }

  async function load(cid: string) {
    const existing = artifacts.get(cid);
    if (existing) return existing;

    const data = await readVerified(client, cid, config);
    closureBytes += data.length;
    if (closureBytes > config.ARTIFACT_MAX_CLOSURE_BYTES) {
      throw new Error('artifact closure exceeds its compressed byte limit');
    }
    artifacts.set(cid, data);
    return data;
  }

  addExpected(rootCid, true);
  for (const metadataCid of metadataCidValues) addExpected(metadataCid, false);

  for (let index = 0; index < packageQueue.length; index++) {
    const packageCid = packageQueue[index];
    const data = await load(packageCid);
    const parsed = parseDeployment(data, config);
    closureInflatedBytes += parsed.inflatedBytes;
    if (closureInflatedBytes > config.ARTIFACT_MAX_CLOSURE_INFLATED_BYTES) {
      throw new Error('artifact closure exceeds its inflated byte limit');
    }

    addExpected(parsed.deployment.miscUrl, false);
    let imports: ReturnType<typeof getDeploymentImports>;
    try {
      imports = getDeploymentImports(parsed.deployment);
    } catch {
      throw new Error('package contains invalid deployment imports');
    }
    for (const imported of imports) {
      addExpected(imported?.url, true);
    }
  }

  for (const cid of expectedCids) {
    await load(cid);
  }

  assertExactClosure(expectedCids, artifacts.keys());
  return { artifacts, packageCids, inflatedBytes: closureInflatedBytes };
}

export async function mirrorArtifactClosure(
  client: ArtifactFacadeClient,
  rootCid: string,
  metadataCids: string[],
  config: ArtifactWorkerConfig
) {
  const closure = await discoverArtifactClosure(client, rootCid, metadataCids, config);
  const mirrored: string[] = [];

  for (const [cid, data] of closure.artifacts) {
    mirrored.push(await client.write(cid, data));
  }

  assertExactClosure(closure.artifacts.keys(), mirrored);
  return closure;
}

export async function mirrorSingleArtifact(client: ArtifactFacadeClient, cidValue: string, config: ArtifactWorkerConfig) {
  const cid = normalizeCid(cidValue);
  const data = await readVerified(client, cid, config);
  const mirroredCid = await client.write(cid, data);
  assertExactClosure([cid], [mirroredCid]);
}
