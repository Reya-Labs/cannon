import { createHash } from 'node:crypto';
import {
  lstat,
  opendir,
  readFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { getContentCID } from '@usecannon/artifact-codec';

const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_ARTIFACTS = 512;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_ENTRIES = MAX_ARTIFACTS + 1;
const INVENTORY_KEYS = Object.freeze([
  'schemaVersion',
  'manifestSha256',
  'artifacts',
  'inventorySha256',
]);
const ARTIFACT_KEYS = Object.freeze(['bytes', 'cid', 'roles']);

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        expected.includes(key)
    )
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function boundedDirectoryEntries(root) {
  const entries = [];
  try {
    const directory = await opendir(root);
    for await (const entry of directory) {
      if (entries.length >= MAX_CACHE_ENTRIES) {
        throw new Error('too many entries');
      }
      entries.push(entry);
    }
  } catch {
    throw new Error('local artifact cache contains an unexpected entry');
  }
  return entries;
}

export async function loadVerifiedLocalArtifactCache({
  cacheDir,
  manifestSha256,
}) {
  if (
    typeof cacheDir !== 'string' ||
    !path.isAbsolute(cacheDir) ||
    !DIGEST_PATTERN.test(manifestSha256)
  ) {
    throw new Error('local artifact cache options are invalid');
  }
  const requestedRoot = path.resolve(cacheDir);
  let requestedRootMetadata;
  try {
    requestedRootMetadata = await lstat(requestedRoot);
  } catch {
    throw new Error('local artifact cache directory is invalid');
  }
  if (
    !requestedRootMetadata.isDirectory() ||
    requestedRootMetadata.isSymbolicLink()
  ) {
    throw new Error('local artifact cache directory is invalid');
  }
  const root = await realpath(requestedRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('local artifact cache directory is invalid');
  }
  const entries = await boundedDirectoryEntries(root);
  const inventoryEntry = entries.find(({ name }) => name === 'inventory.json');
  if (
    inventoryEntry === undefined ||
    !inventoryEntry.isFile() ||
    inventoryEntry.isSymbolicLink()
  ) {
    throw new Error('local artifact cache inventory is invalid');
  }

  let inventory;
  try {
    const inventoryPath = path.join(root, 'inventory.json');
    const metadata = await lstat(inventoryPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > MAX_INVENTORY_BYTES
    ) {
      throw new Error('invalid inventory file');
    }
    const bytes = await readFile(inventoryPath);
    if (bytes.byteLength !== metadata.size) {
      throw new Error('invalid inventory file');
    }
    inventory = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('local artifact cache inventory is invalid');
  }
  if (
    !exactKeys(inventory, INVENTORY_KEYS) ||
    inventory.schemaVersion !== 1 ||
    inventory.manifestSha256 !== manifestSha256 ||
    !DIGEST_PATTERN.test(inventory.inventorySha256) ||
    !Array.isArray(inventory.artifacts) ||
    inventory.artifacts.length < 1 ||
    inventory.artifacts.length > MAX_ARTIFACTS
  ) {
    throw new Error('local artifact cache inventory is invalid');
  }
  const expectedInventoryDigest = sha256(
    JSON.stringify({
      schemaVersion: inventory.schemaVersion,
      manifestSha256: inventory.manifestSha256,
      artifacts: inventory.artifacts,
    })
  );
  if (inventory.inventorySha256 !== expectedInventoryDigest) {
    throw new Error('local artifact cache inventory digest is invalid');
  }
  const verified = new Map();
  let previousCid = '';
  let totalBytes = 0;
  for (const entry of inventory.artifacts) {
    if (
      !exactKeys(entry, ARTIFACT_KEYS) ||
      !CID_V0_PATTERN.test(entry.cid) ||
      entry.cid <= previousCid ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      entry.bytes > MAX_ARTIFACT_BYTES ||
      !Array.isArray(entry.roles) ||
      entry.roles.length < 1 ||
      entry.roles.length > 16 ||
      entry.roles.some(
        (role, index) =>
          typeof role !== 'string' ||
          !ROLE_PATTERN.test(role) ||
          (index > 0 && role <= entry.roles[index - 1])
      )
    ) {
      throw new Error('local artifact cache inventory entry is invalid');
    }
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('local artifact cache exceeds its aggregate limit');
    }
    const artifactPath = path.join(root, entry.cid);
    const metadata = await lstat(artifactPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size !== entry.bytes
    ) {
      throw new Error('local artifact cache file is invalid');
    }
    const bytes = new Uint8Array(await readFile(artifactPath));
    if ((await getContentCID(bytes)) !== entry.cid) {
      throw new Error('local artifact cache CID verification failed');
    }
    verified.set(entry.cid, bytes);
    previousCid = entry.cid;
  }
  const expectedEntries = new Set([
    'inventory.json',
    ...inventory.artifacts.map(({ cid }) => cid),
  ]);
  if (
    entries.length !== expectedEntries.size ||
    entries.some(
      (entry) =>
        !expectedEntries.has(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
    )
  ) {
    throw new Error('local artifact cache contains an unexpected entry');
  }

  return Object.freeze({
    inventory: Object.freeze({
      ...inventory,
      artifacts: Object.freeze(
        inventory.artifacts.map((entry) =>
          Object.freeze({
            ...entry,
            roles: Object.freeze([...entry.roles]),
          })
        )
      ),
    }),
    async readArtifact(cid) {
      if (!CID_V0_PATTERN.test(cid) || !verified.has(cid)) {
        throw new Error('local artifact is outside the verified cache');
      }
      return new Uint8Array(verified.get(cid));
    },
  });
}
