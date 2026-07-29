import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compress,
  getContentCID,
} from '@usecannon/artifact-codec';
import { loadVerifiedLocalArtifactCache } from '../test-support/local-artifact-cache.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function cacheFixture({ corrupt = false } = {}) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'reya-artifact-cache-'));
  const bytes = compress(JSON.stringify({ status: 'complete' }));
  const cid = await getContentCID(bytes);
  const manifestSha256 = '1'.repeat(64);
  const artifacts = [
    {
      bytes: bytes.byteLength,
      cid,
      roles: ['baseline-deploy'],
    },
  ];
  const canonical = {
    schemaVersion: 1,
    manifestSha256,
    artifacts,
  };
  const inventory = {
    ...canonical,
    inventorySha256: sha256(JSON.stringify(canonical)),
  };
  await writeFile(path.join(cacheDir, cid), corrupt ? new Uint8Array(bytes.byteLength) : bytes);
  await writeFile(
    path.join(cacheDir, 'inventory.json'),
    `${JSON.stringify(inventory, null, 2)}\n`
  );
  return { bytes, cacheDir, cid, manifestSha256 };
}

test('local artifact cache verifies its inventory and every CID', async (context) => {
  const fixture = await cacheFixture();
  context.after(() => rm(fixture.cacheDir, { force: true, recursive: true }));
  const cache = await loadVerifiedLocalArtifactCache(fixture);
  assert.deepEqual(await cache.readArtifact(fixture.cid), fixture.bytes);
  await assert.rejects(
    cache.readArtifact('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
    /outside the verified cache/
  );
});

test('local artifact cache rejects content that does not match its CID', async (context) => {
  const fixture = await cacheFixture({ corrupt: true });
  context.after(() => rm(fixture.cacheDir, { force: true, recursive: true }));
  await assert.rejects(
    loadVerifiedLocalArtifactCache(fixture),
    /CID verification failed/
  );
});

test('local artifact cache rejects a symlink root before resolving it', async (context) => {
  const fixture = await cacheFixture();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'reya-cache-root-link-'));
  context.after(() => rm(fixture.cacheDir, { force: true, recursive: true }));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const cacheLink = path.join(parent, 'cache');
  await symlink(fixture.cacheDir, cacheLink);

  for (const cacheDir of [cacheLink, `${cacheLink}${path.sep}`]) {
    await assert.rejects(
      loadVerifiedLocalArtifactCache({
        cacheDir,
        manifestSha256: fixture.manifestSha256,
      }),
      /cache directory is invalid/
    );
  }
});

test('local artifact cache rejects symlink inventory and artifact files', async (context) => {
  await context.test('inventory', async () => {
    const fixture = await cacheFixture();
    const inventoryPath = path.join(fixture.cacheDir, 'inventory.json');
    const target = path.join(fixture.cacheDir, 'inventory-target');
    await writeFile(target, await readFile(inventoryPath));
    await unlink(inventoryPath);
    await symlink(target, inventoryPath);
    try {
      await assert.rejects(
        loadVerifiedLocalArtifactCache(fixture),
        /cache inventory is invalid/
      );
    } finally {
      await rm(fixture.cacheDir, { force: true, recursive: true });
    }
  });

  await context.test('artifact', async () => {
    const fixture = await cacheFixture();
    const artifactPath = path.join(fixture.cacheDir, fixture.cid);
    const target = path.join(fixture.cacheDir, 'artifact-target');
    await writeFile(target, await readFile(artifactPath));
    await unlink(artifactPath);
    await symlink(target, artifactPath);
    try {
      await assert.rejects(
        loadVerifiedLocalArtifactCache(fixture),
        /cache file is invalid|unexpected entry/
      );
    } finally {
      await rm(fixture.cacheDir, { force: true, recursive: true });
    }
  });
});

test('local artifact cache rejects unexpected and non-regular entries', async (context) => {
  await context.test('unexpected file', async () => {
    const fixture = await cacheFixture();
    await writeFile(path.join(fixture.cacheDir, 'unexpected'), 'data');
    try {
      await assert.rejects(
        loadVerifiedLocalArtifactCache(fixture),
        /unexpected entry/
      );
    } finally {
      await rm(fixture.cacheDir, { force: true, recursive: true });
    }
  });

  await context.test('artifact directory', async () => {
    const fixture = await cacheFixture();
    await unlink(path.join(fixture.cacheDir, fixture.cid));
    await mkdir(path.join(fixture.cacheDir, fixture.cid));
    try {
      await assert.rejects(
        loadVerifiedLocalArtifactCache(fixture),
        /cache file is invalid/
      );
    } finally {
      await rm(fixture.cacheDir, { force: true, recursive: true });
    }
  });
});

test('local artifact cache rejects an oversized inventory before parsing it', async (context) => {
  const fixture = await cacheFixture();
  context.after(() =>
    rm(fixture.cacheDir, { force: true, recursive: true })
  );
  await writeFile(
    path.join(fixture.cacheDir, 'inventory.json'),
    new Uint8Array(1024 * 1024 + 1)
  );
  await assert.rejects(
    loadVerifiedLocalArtifactCache(fixture),
    /cache inventory is invalid/
  );
});

test('local artifact cache bounds directory enumeration', async (context) => {
  const fixture = await cacheFixture();
  context.after(() =>
    rm(fixture.cacheDir, { force: true, recursive: true })
  );
  await Promise.all(
    Array.from({ length: 512 }, (_, index) =>
      writeFile(path.join(fixture.cacheDir, `unexpected-${index}`), '')
    )
  );
  await assert.rejects(
    loadVerifiedLocalArtifactCache(fixture),
    /unexpected entry/
  );
});
