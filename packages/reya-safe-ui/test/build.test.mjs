import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildExport } from '../src/build.mjs';
import { compareCanonicalText } from '../src/config.mjs';
import { scanExport } from '../scripts/scan-export.mjs';

const BUILD_SHA = '89abcdef0123456789abcdef0123456789abcdef';
const ENV = Object.freeze({
  REYA_SAFE_UI_ACTIVATION: 'disabled',
  REYA_SAFE_UI_BUILD_SHA: BUILD_SHA,
  REYA_SAFE_UI_CHAIN_ID: '1729',
  REYA_SAFE_UI_PROFILE: 'reya-mainnet',
});

async function snapshot(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const result = [];

  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name)
  )) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await snapshot(root, target)));
    } else {
      result.push({
        path: path.relative(root, target).split(path.sep).join('/'),
        bytes: await readFile(target),
      });
    }
  }
  return result;
}

test('builds a deterministic, disabled-only static export', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-build-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const first = path.join(temporary, 'first');
  const second = path.join(temporary, 'second');

  const firstResult = await buildExport({ env: ENV, outDir: first });
  const secondResult = await buildExport({ env: ENV, outDir: second });

  assert.deepEqual(await snapshot(first), await snapshot(second));
  assert.equal(firstResult.buildSha, BUILD_SHA);
  assert.equal(firstResult.configDigest, secondResult.configDigest);
  assert.equal(firstResult.sourceDigest, secondResult.sourceDigest);

  const verified = await scanExport(first);
  assert.equal(verified.buildSha, BUILD_SHA);
  assert.equal(verified.configDigest, firstResult.configDigest);
  assert.equal(verified.sourceDigest, firstResult.sourceDigest);
  assert.deepEqual(verified.files, [
    '_headers',
    'assets/app.css',
    'index.html',
    'release.json',
  ]);

  const html = await readFile(path.join(first, 'index.html'), 'utf8');
  assert.match(html, /Proposal signing is not activated/);
  assert.ok(html.includes(BUILD_SHA));
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<form\b/i);
  assert.doesNotMatch(html, /\bhttps?:\/\//i);

  const release = JSON.parse(
    await readFile(path.join(first, 'release.json'), 'utf8')
  );
  assert.equal(release.activation, 'disabled');
  assert.equal(release.profile.chainId, 1729);
  assert.match(release.build.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(release.build.configDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(release.export.assetDigest, /^sha256:[0-9a-f]{64}$/);
});

test('atomically replaces a stale export without retaining undeclared files', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-replace-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const output = path.join(temporary, 'dist');
  await buildExport({ env: ENV, outDir: output });
  await writeFile(path.join(output, 'stale.js'), 'stale');

  await buildExport({ env: ENV, outDir: output });

  assert.deepEqual(
    (await snapshot(output)).map((entry) => entry.path),
    ['_headers', 'assets/app.css', 'index.html', 'release.json']
  );
  await assert.doesNotReject(() => scanExport(output));
});

test('does not create an export when configuration validation fails', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-invalid-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const output = path.join(temporary, 'dist');

  await assert.rejects(
    () =>
      buildExport({
        env: { ...ENV, REYA_SAFE_UI_ACTIVATION: 'enabled' },
        outDir: output,
      }),
    /must be exactly "disabled"/
  );
  await assert.rejects(() => readdir(output), /ENOENT/);
});
