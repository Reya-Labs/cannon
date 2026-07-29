import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContentCID } from '@usecannon/artifact-codec';
import { Inflate } from 'pako';
import { isCanonicalCidV0 } from '../src/clients/schema.mjs';
import {
  LOCAL_QA_FIXTURE_PATH,
  loadLocalQaResolutionManifest,
  validateLocalQaResolutionManifest,
} from '../test-support/local-qa-resolution.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const DEFAULT_CAT_PATH = '/api/v0/cat';
const INFLATE_CHUNK_BYTES = 64 * 1024;
const MAX_ARTIFACTS = 512;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_DEPLOYMENT_JSON_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_STATE_NODES = 1_000_000;
const MAX_STATE_DEPTH = 64;
const CID_URL_PATTERN = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const INVENTORY_KEYS = Object.freeze([
  'schemaVersion',
  'manifestSha256',
  'artifacts',
  'inventorySha256',
]);
const INVENTORY_ARTIFACT_KEYS = Object.freeze(['bytes', 'cid', 'roles']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function computeArtifactCid(value) {
  if (!(value instanceof Uint8Array)) {
    throw new Error('artifact CID input must be bytes');
  }
  const rootCid = await getContentCID(value);
  if (!isCanonicalCidV0(rootCid)) {
    throw new Error('artifact CID calculation produced no canonical root');
  }
  return rootCid;
}

export function validateArtifactOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('--origin is required');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('artifact origin is invalid');
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '[::1]');
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('artifact origin must be a credential-free HTTPS origin');
  }
  return url.origin;
}

function validateCatPath(value) {
  if (
    typeof value !== 'string' ||
    !/^\/[a-zA-Z0-9/_-]+$/.test(value) ||
    value.includes('//') ||
    value.endsWith('/')
  ) {
    throw new Error('artifact cat path is invalid');
  }
  return value;
}

function artifactUrl(origin, catPath, cid) {
  const url = new URL(origin);
  url.pathname = catPath;
  url.searchParams.set('arg', cid);
  return url.href;
}

async function boundedArtifactRequest({
  catPath,
  cid,
  fetchImpl,
  maximumBytes,
  origin,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response;
  let reader;
  let completed = false;
  try {
    response = await fetchImpl(artifactUrl(origin, catPath, cid), {
      cache: 'no-store',
      credentials: 'omit',
      headers: Object.freeze({ Accept: 'application/octet-stream' }),
      method: 'POST',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (
      response === null ||
      typeof response !== 'object' ||
      response.status !== 200 ||
      response.redirected !== false ||
      response.headers.get('content-type')?.split(';', 1)[0].trim() !==
        'application/octet-stream' ||
      response.body === null
    ) {
      throw new Error(`artifact ${cid} request was rejected`);
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
        Number(declaredLength) > maximumBytes)
    ) {
      throw new Error(`artifact ${cid} exceeds the byte limit`);
    }
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new Error(`artifact ${cid} returned invalid bytes`);
      }
      length += result.value.byteLength;
      if (length > maximumBytes) {
        controller.abort();
        throw new Error(`artifact ${cid} exceeds the byte limit`);
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (bytes.byteLength < 1) {
      throw new Error(`artifact ${cid} returned no bytes`);
    }
    completed = true;
    return bytes;
  } finally {
    clearTimeout(timeout);
    if (response?.body && !completed) {
      try {
        if (reader) await reader.cancel();
        else await response.body.cancel();
      } catch {
        // The request is already failed closed.
      }
    }
  }
}

async function ensureCacheDirectory(cacheDir) {
  if (
    typeof cacheDir !== 'string' ||
    cacheDir.length < 1 ||
    cacheDir.includes('\0')
  ) {
    throw new Error('artifact cache directory is invalid');
  }
  const requestedRoot = path.resolve(cacheDir);
  let metadata;
  try {
    metadata = await lstat(requestedRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    metadata = await lstat(requestedRoot);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('artifact cache directory is invalid');
  }
  return realpath(requestedRoot);
}

async function readCachedArtifact(target, maximumBytes) {
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error('cached artifact file is invalid');
  }
  return new Uint8Array(await readFile(target));
}

async function writeCreateOnly(target, bytes) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString(
    'hex'
  )}`;
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, target);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function hydrateArtifact({
  cacheDir,
  catPath = DEFAULT_CAT_PATH,
  cid,
  fetchImpl = globalThis.fetch,
  maximumBytes = MAX_ARTIFACT_BYTES,
  origin,
}) {
  if (!isCanonicalCidV0(cid)) throw new Error('artifact CID is invalid');
  const canonicalOrigin = validateArtifactOrigin(origin);
  const canonicalCatPath = validateCatPath(catPath);
  if (typeof fetchImpl !== 'function') {
    throw new Error('artifact fetch implementation is invalid');
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('artifact byte limit is invalid');
  }
  const root = await ensureCacheDirectory(cacheDir);
  const target = path.join(root, cid);
  let bytes = await readCachedArtifact(target, maximumBytes);
  if (bytes === undefined) {
    bytes = await boundedArtifactRequest({
      catPath: canonicalCatPath,
      cid,
      fetchImpl,
      maximumBytes,
      origin: canonicalOrigin,
    });
    if ((await computeArtifactCid(bytes)) !== cid) {
      throw new Error(`artifact ${cid} failed CID verification`);
    }
    await writeCreateOnly(target, bytes);
    bytes = await readCachedArtifact(target, maximumBytes);
    if (bytes === undefined) {
      throw new Error(`artifact ${cid} was not cached`);
    }
  }
  if ((await computeArtifactCid(bytes)) !== cid) {
    throw new Error(`cached artifact ${cid} failed CID verification`);
  }
  return bytes;
}

function inflateDeployment(bytes, cid, maximumBytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_DEPLOYMENT_JSON_BYTES
  ) {
    throw new Error(`deployment artifact ${cid} has invalid decode options`);
  }
  const chunks = [];
  let decodedBytes = 0;
  let exceededLimit = false;
  const inflate = new Inflate({ chunkSize: INFLATE_CHUNK_BYTES });
  inflate.onData = (chunk) => {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error(`deployment artifact ${cid} returned invalid bytes`);
    }
    if (chunk.byteLength > maximumBytes - decodedBytes) {
      exceededLimit = true;
      throw new Error(
        `deployment artifact ${cid} exceeds the JSON byte limit`
      );
    }
    decodedBytes += chunk.byteLength;
    chunks.push(chunk);
  };
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += INFLATE_CHUNK_BYTES) {
      const end = Math.min(offset + INFLATE_CHUNK_BYTES, bytes.byteLength);
      inflate.push(bytes.subarray(offset, end), end === bytes.byteLength);
      if (inflate.err) break;
    }
  } catch (error) {
    if (exceededLimit) throw error;
    throw new Error(`deployment artifact ${cid} cannot be inflated`);
  }
  if (exceededLimit) {
    throw new Error(`deployment artifact ${cid} exceeds the JSON byte limit`);
  }
  if (inflate.err || !inflate.ended) {
    throw new Error(`deployment artifact ${cid} cannot be inflated`);
  }
  const decoded = new Uint8Array(decodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new Error(`deployment artifact ${cid} is not UTF-8`);
  }
}

export function parseDeploymentArtifact(
  bytes,
  cid,
  maximumDecodedBytes = MAX_DEPLOYMENT_JSON_BYTES
) {
  const text = inflateDeployment(bytes, cid, maximumDecodedBytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`deployment artifact ${cid} is not JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`deployment artifact ${cid} is invalid`);
  }
  return value;
}

function cidFromUrl(value, label) {
  const match = typeof value === 'string' && CID_URL_PATTERN.exec(value);
  if (!match || !isCanonicalCidV0(match[1])) {
    throw new Error(`${label} is not a canonical Cannon artifact URL`);
  }
  return match[1];
}

export function discoverBaselineImportCids(state) {
  const found = new Set();
  const active = new Set();
  let nodes = 0;

  const visit = (value, depth) => {
    nodes += 1;
    if (nodes > MAX_STATE_NODES || depth > MAX_STATE_DEPTH) {
      throw new Error('baseline state exceeds structural limits');
    }
    if (typeof value === 'string') {
      const match = CID_URL_PATTERN.exec(value);
      if (match && isCanonicalCidV0(match[1])) found.add(match[1]);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (active.has(value)) {
      throw new Error('baseline state contains a cycle');
    }
    active.add(value);
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
    } else {
      for (const key of Reflect.ownKeys(value)) {
        if (
          typeof key !== 'string' ||
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype'
        ) {
          throw new Error('baseline state contains a forbidden key');
        }
        visit(value[key], depth + 1);
      }
    }
    active.delete(value);
  };

  visit(state, 0);
  return Object.freeze([...found].sort());
}

export async function collectArtifactClosure({
  baselineCid,
  blueprintCids,
  decodeDeployment,
  readArtifact,
}) {
  const roles = new Map();
  const lengths = new Map();
  const pending = [];
  const processed = new Set();
  const scheduled = new Set();
  const loaded = new Map();
  let totalBytes = 0;

  const enqueue = (cid, role) => {
    if (!isCanonicalCidV0(cid)) {
      throw new Error(`closure contains invalid CID for ${role}`);
    }
    if (!roles.has(cid)) {
      if (roles.size >= MAX_ARTIFACTS) {
        throw new Error('artifact closure exceeds its unique artifact limit');
      }
      roles.set(cid, new Set());
    }
    const pair = `${cid}:${role}`;
    if (scheduled.has(pair)) return;
    scheduled.add(pair);
    roles.get(cid).add(role);
    pending.push({ cid, role });
  };

  enqueue(baselineCid, 'baseline-deploy');
  for (const cid of blueprintCids) enqueue(cid, 'blueprint-deploy');

  while (pending.length > 0) {
    const { cid, role } = pending.shift();
    const pair = `${cid}:${role}`;
    if (processed.has(pair)) continue;
    processed.add(pair);
    let bytes = loaded.get(cid);
    if (bytes === undefined) {
      const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
      if (remainingBytes < 1) {
        throw new Error('artifact closure exceeds its aggregate byte limit');
      }
      bytes = await readArtifact(
        cid,
        Object.freeze({
          maximumBytes: Math.min(MAX_ARTIFACT_BYTES, remainingBytes),
        })
      );
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_ARTIFACT_BYTES
      ) {
        throw new Error(`closure reader returned invalid bytes for ${cid}`);
      }
      if (bytes.byteLength > remainingBytes) {
        throw new Error('artifact closure exceeds its aggregate byte limit');
      }
      totalBytes += bytes.byteLength;
      loaded.set(cid, bytes);
      lengths.set(cid, bytes.byteLength);
    }
    if (
      role !== 'baseline-deploy' &&
      role !== 'baseline-import-deploy' &&
      role !== 'blueprint-deploy'
    ) {
      continue;
    }
    const deployment = await decodeDeployment(bytes, cid, role);
    const allowedChainIds =
      role === 'blueprint-deploy'
        ? [13370]
        : role === 'baseline-deploy'
          ? [1729]
          : [1729, 13370];
    if (
      deployment === null ||
      typeof deployment !== 'object' ||
      Array.isArray(deployment) ||
      !allowedChainIds.includes(deployment.chainId) ||
      deployment.status !== 'complete'
    ) {
      throw new Error(
        `${role} ${cid} is not a complete allowed-chain deployment`
      );
    }
    if (role === 'baseline-import-deploy') {
      roles.get(cid).delete(role);
      roles
        .get(cid)
        .add(`baseline-import-deploy-${deployment.chainId}`);
    }
    const miscCid = cidFromUrl(
      deployment.miscUrl,
      `deployment ${cid} miscUrl`
    );
    enqueue(miscCid, 'deployment-misc');

    if (
      role === 'baseline-deploy' ||
      role === 'baseline-import-deploy'
    ) {
      for (const importCid of discoverBaselineImportCids(deployment.state)) {
        if (importCid !== miscCid) {
          enqueue(importCid, 'baseline-import-deploy');
        }
      }
    }
  }

  return Object.freeze(
    [...roles]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([cid, artifactRoles]) =>
        Object.freeze({
          bytes: lengths.get(cid),
          cid,
          roles: Object.freeze([...artifactRoles].sort()),
        })
      )
  );
}

function inventoryFor(manifestSha256, artifacts) {
  const canonical = {
    schemaVersion: 1,
    manifestSha256,
    artifacts,
  };
  return {
    ...canonical,
    inventorySha256: sha256(JSON.stringify(canonical)),
  };
}

async function writeInventory(cacheDir, inventory) {
  if (
    JSON.stringify(Object.keys(inventory)) !== JSON.stringify(INVENTORY_KEYS) ||
    inventory.artifacts.some(
      (entry) =>
        JSON.stringify(Object.keys(entry)) !==
        JSON.stringify(INVENTORY_ARTIFACT_KEYS)
    )
  ) {
    throw new Error('artifact inventory is not canonical');
  }
  const target = path.join(cacheDir, 'inventory.json');
  const bytes = `${JSON.stringify(inventory, null, 2)}\n`;
  try {
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('existing artifact inventory is invalid');
    }
    if ((await readFile(target, 'utf8')) !== bytes) {
      throw new Error('existing artifact inventory does not match hydration');
    }
  }
}

export async function hydrateLocalQaArtifacts({
  cacheDir,
  catPath = DEFAULT_CAT_PATH,
  fetchImpl = globalThis.fetch,
  manifest,
  origin,
}) {
  const validated = validateLocalQaResolutionManifest(manifest);
  const output =
    cacheDir ??
    path.join(
      PACKAGE_ROOT,
      '.cache',
      'local-qa-artifacts',
      validated.manifestSha256
    );
  const artifacts = await collectArtifactClosure({
    baselineCid: validated.baseline.deployCid,
    blueprintCids: validated.resolutions.map(({ deployCid }) => deployCid),
    decodeDeployment: (bytes, cid) => parseDeploymentArtifact(bytes, cid),
    readArtifact: (cid, { maximumBytes }) =>
      hydrateArtifact({
        cacheDir: output,
        catPath,
        cid,
        fetchImpl,
        maximumBytes,
        origin,
      }),
  });
  const inventory = inventoryFor(validated.manifestSha256, artifacts);
  await writeInventory(output, inventory);
  return Object.freeze({ cacheDir: output, inventory });
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      value === undefined ||
      !['--origin', '--cat-path', '--manifest', '--cache-dir'].includes(flag) ||
      Object.hasOwn(options, flag)
    ) {
      throw new Error(
        'usage: hydrate-local-qa-artifacts.mjs --origin <origin> [--cat-path <path>] [--manifest <file>] [--cache-dir <directory>]'
      );
    }
    options[flag] = value;
  }
  if (!Object.hasOwn(options, '--origin')) {
    throw new Error('--origin is required');
  }
  return options;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const options = parseCli(process.argv.slice(2));
    const fixturePath = options['--manifest'] ?? LOCAL_QA_FIXTURE_PATH;
    const manifest = await loadLocalQaResolutionManifest(fixturePath);
    const result = await hydrateLocalQaArtifacts({
      cacheDir: options['--cache-dir'],
      catPath: options['--cat-path'] ?? DEFAULT_CAT_PATH,
      manifest,
      origin: options['--origin'],
    });
    process.stdout.write(
      `Hydrated ${result.inventory.artifacts.length} CID-verified Cannon artifacts into ${result.cacheDir}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Local QA artifact hydration failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
