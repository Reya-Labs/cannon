import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCanonicalCidV0 } from '../src/clients/schema.mjs';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export const LOCAL_QA_SOURCE = Object.freeze({
  repository: 'Reya-Labs/reya-deployments',
  commit: '2b10669075b91eb8db781d199292f30c52f8e994',
  root: 'packages/tomls/src/omnibus/reya_network.toml',
  bundleSha256:
    'd5fd78c3d3774a4b0d51ee570a436ebbde72f415829650c64b99711daa74c689',
});

export const LOCAL_QA_REGISTRY_SNAPSHOTS = Object.freeze([
  Object.freeze({
    priority: 0,
    name: 'OP Mainnet',
    chainId: 10,
    address: '0x8E5C7EFC9636A6A0408A46BB7F617094B81e5dba',
    blockNumber: '154866869',
    blockHash:
      '0x8c0efa302183d198583c8b3db2b0f3d04dc85509d6b76e7c2bb7335d194a055d',
  }),
  Object.freeze({
    priority: 1,
    name: 'Ethereum Mainnet',
    chainId: 1,
    address: '0x8E5C7EFC9636A6A0408A46BB7F617094B81e5dba',
    blockNumber: '25638894',
    blockHash:
      '0x6495b7928d857949e49e57a4041d452204d0b9ab79dc83cdae2099d1b584dcd2',
  }),
]);

export const LOCAL_QA_BASELINE = Object.freeze({
  chainId: 1729,
  fullPackageRef: 'reya-omnibus:1.0.158@main',
  deployCid: 'QmaXwNU4gdBwgx4nZDV7qsPCG2GQXhyKqvxWEQoiF7CmZN',
});

export const LOCAL_QA_SAFE_ADDRESS =
  '0x1fe50318e5e3165742edc9c4a15d997bdb935eb9';

export const LOCAL_QA_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  `reya-network-${LOCAL_QA_SOURCE.commit}`,
  'resolution.json'
);

const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion',
  'purpose',
  'cannonVersion',
  'stateFormatVersion',
  'safeAddress',
  'source',
  'registrySnapshots',
  'baseline',
  'resolutions',
  'manifestSha256',
]);
const SOURCE_KEYS = Object.freeze([
  'repository',
  'commit',
  'root',
  'bundleSha256',
]);
const SNAPSHOT_KEYS = Object.freeze([
  'priority',
  'name',
  'chainId',
  'address',
  'blockNumber',
  'blockHash',
]);
const BASELINE_KEYS = Object.freeze([
  'chainId',
  'fullPackageRef',
  'deployCid',
]);
const RESOLUTION_KEYS = Object.freeze([
  'chainId',
  'fullPackageRef',
  'deployCid',
  'registryChainId',
  'resolutionType',
]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PACKAGE_REF_PATTERN =
  /^[a-z0-9][a-z0-9-]{1,29}[a-z0-9]:[A-Za-z0-9][A-Za-z0-9._+-]{0,31}@[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;
const RESOLUTION_TYPES = new Set(['legacy-unset', 'version']);

export const LOCAL_QA_PACKAGE_REFS = Object.freeze([
  'reya-core:1.0.26@router',
  'reya-core:1.0.2@account-nft-router',
  'reya-exchange-pass-nft:1.0.0@router',
  'reya-exchange-passive-pool:1.0.13@router',
  'reya-instrument-passive-perp:1.0.56@router',
  'reya-oracle-adapters:1.0.1@proxy',
  'reya-oracle-adapters:1.0.8@router',
  'reya-oracle-manager:1.0.5@router',
  'reya-orders-gateway:1.0.1@proxy',
  'reya-orders-gateway:1.0.27@router',
  'reya-periphery:1.0.14@router',
  'reya-ranks:1.0.0@router',
  'reya-rusd:1.0.0@router',
  'reya-sbt:1.0.0@proxy',
  'reya-sbt:1.0.2@router',
  'reya-share-tokens:1.0.0@proxy',
  'reya-share-tokens:1.0.2@router',
  'reya-tokens:1.0.0@proxy',
  'reya-tokens:1.0.1@router',
]);

function reject(message) {
  throw new Error(`local QA resolution fixture rejected: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOrderedKeys(value, expected, label) {
  if (
    !isPlainObject(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(expected) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string')
  ) {
    reject(`${label} keys are not canonical`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalWithoutDigest(value) {
  return {
    schemaVersion: value.schemaVersion,
    purpose: value.purpose,
    cannonVersion: value.cannonVersion,
    stateFormatVersion: value.stateFormatVersion,
    safeAddress: value.safeAddress,
    source: { ...value.source },
    registrySnapshots: value.registrySnapshots.map((entry) => ({ ...entry })),
    baseline: { ...value.baseline },
    resolutions: value.resolutions.map((entry) => ({ ...entry })),
  };
}

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateLocalQaResolutionManifest(value) {
  assertOrderedKeys(value, TOP_LEVEL_KEYS, 'top-level');
  if (
    value.schemaVersion !== 1 ||
    value.purpose !== 'local-qa-only' ||
    value.cannonVersion !== '2.26.1' ||
    value.stateFormatVersion !== 7 ||
    value.safeAddress !== LOCAL_QA_SAFE_ADDRESS
  ) {
    reject('identity is invalid');
  }

  assertOrderedKeys(value.source, SOURCE_KEYS, 'source');
  if (!sameJson(value.source, LOCAL_QA_SOURCE)) {
    reject('source binding is invalid');
  }

  if (
    !Array.isArray(value.registrySnapshots) ||
    value.registrySnapshots.length !== LOCAL_QA_REGISTRY_SNAPSHOTS.length
  ) {
    reject('registry snapshots are incomplete');
  }
  for (const [index, snapshot] of value.registrySnapshots.entries()) {
    assertOrderedKeys(snapshot, SNAPSHOT_KEYS, `registry snapshot ${index}`);
    if (!sameJson(snapshot, LOCAL_QA_REGISTRY_SNAPSHOTS[index])) {
      reject(`registry snapshot ${index} is invalid`);
    }
  }

  assertOrderedKeys(value.baseline, BASELINE_KEYS, 'baseline');
  if (!sameJson(value.baseline, LOCAL_QA_BASELINE)) {
    reject('upgrade baseline is invalid');
  }

  if (
    !Array.isArray(value.resolutions) ||
    value.resolutions.length !== LOCAL_QA_PACKAGE_REFS.length
  ) {
    reject('package resolution set is incomplete');
  }
  const registryChains = new Set(
    LOCAL_QA_REGISTRY_SNAPSHOTS.map(({ chainId }) => chainId)
  );
  const seen = new Set([
    `${LOCAL_QA_BASELINE.chainId}:${LOCAL_QA_BASELINE.fullPackageRef}`,
  ]);
  let previousRef = '';
  for (const [index, resolution] of value.resolutions.entries()) {
    assertOrderedKeys(resolution, RESOLUTION_KEYS, `resolution ${index}`);
    const key = `${resolution.chainId}:${resolution.fullPackageRef}`;
    if (
      resolution.chainId !== 13370 ||
      !PACKAGE_REF_PATTERN.test(resolution.fullPackageRef) ||
      resolution.fullPackageRef.includes(':latest@') ||
      !isCanonicalCidV0(resolution.deployCid) ||
      !registryChains.has(resolution.registryChainId) ||
      !RESOLUTION_TYPES.has(resolution.resolutionType) ||
      resolution.fullPackageRef <= previousRef ||
      seen.has(key)
    ) {
      reject(`resolution ${index} is invalid`);
    }
    previousRef = resolution.fullPackageRef;
    seen.add(key);
  }
  if (
    !sameJson(
      value.resolutions.map(({ fullPackageRef }) => fullPackageRef),
      LOCAL_QA_PACKAGE_REFS
    )
  ) {
    reject('package references do not match the pinned source closure');
  }

  if (
    typeof value.manifestSha256 !== 'string' ||
    !DIGEST_PATTERN.test(value.manifestSha256)
  ) {
    reject('manifest digest is invalid');
  }
  const canonical = canonicalWithoutDigest(value);
  const expectedDigest = sha256(JSON.stringify(canonical));
  if (value.manifestSha256 !== expectedDigest) {
    reject('manifest digest does not match canonical content');
  }

  const normalized = {
    ...canonical,
    manifestSha256: expectedDigest,
  };
  if (!sameJson(value, normalized)) {
    reject('manifest encoding is not canonical');
  }
  return freezeDeep(normalized);
}

export async function loadLocalQaResolutionManifest(
  fixturePath = LOCAL_QA_FIXTURE_PATH
) {
  let parsed;
  try {
    const metadata = await lstat(fixturePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_MANIFEST_BYTES
    ) {
      reject('fixture file is invalid');
    }
    const bytes = await readFile(fixturePath);
    if (bytes.byteLength !== metadata.size) {
      reject('fixture file is invalid');
    }
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    reject('fixture cannot be read as JSON');
  }
  return validateLocalQaResolutionManifest(parsed);
}

export function createLocalQaResolutionMap(manifest) {
  const validated = validateLocalQaResolutionManifest(manifest);
  const entries = new Map();
  for (const resolution of validated.resolutions) {
    entries.set(
      `${resolution.chainId}:${resolution.fullPackageRef}`,
      Object.freeze({
        cid: resolution.deployCid,
        mutability:
          resolution.resolutionType === 'version' ? 'version' : '',
      })
    );
  }
  entries.set(
    `${validated.baseline.chainId}:${validated.baseline.fullPackageRef}`,
    Object.freeze({
      cid: validated.baseline.deployCid,
      mutability: 'version',
    })
  );
  return Object.freeze({
    manifestSha256: validated.manifestSha256,
    resolve(input) {
      if (
        !isPlainObject(input) ||
        JSON.stringify(Object.keys(input)) !==
          JSON.stringify(['chainId', 'fullPackageRef']) ||
        !Number.isSafeInteger(input.chainId) ||
        typeof input.fullPackageRef !== 'string'
      ) {
        reject('resolution input is invalid');
      }
      const resolution = entries.get(
        `${input.chainId}:${input.fullPackageRef}`
      );
      if (resolution === undefined) reject('package resolution is not pinned');
      return Object.freeze({
        mutability: resolution.mutability,
        url: `ipfs://${resolution.cid}`,
      });
    },
  });
}

export function resolveLocalQaPackage(resolutionMap, input) {
  if (
    resolutionMap === null ||
    typeof resolutionMap !== 'object' ||
    typeof resolutionMap.resolve !== 'function'
  ) {
    reject('resolution map is invalid');
  }
  return resolutionMap.resolve(input);
}
