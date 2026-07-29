import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildExport } from '../src/build.mjs';
import { digestFiles, sha256 } from '../src/config.mjs';
import { scanExport } from '../scripts/scan-export.mjs';

const ENV = Object.freeze({
  REYA_SAFE_UI_ACTIVATION: 'disabled',
  REYA_SAFE_UI_BUILD_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
  REYA_SAFE_UI_CHAIN_ID: '1729',
  REYA_SAFE_UI_PROFILE: 'reya-mainnet',
});

async function fixture(context) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reya-safe-ui-scan-'));
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const output = path.join(temporary, 'dist');
  await buildExport({ env: ENV, outDir: output });
  return output;
}

test('rejects a hosted dependency anywhere in the export', async (context) => {
  const output = await fixture(context);
  const indexPath = path.join(output, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  await writeFile(
    indexPath,
    html.replace(
      '</body>',
      '<a href="https://repo.usecannon.com">legacy</a></body>'
    )
  );

  await assert.rejects(
    () => scanExport(output),
    /index\.html contains forbidden remote HTTP URL/
  );
});

test('rejects embedded data and protocol-relative resources', async (context) => {
  const dataOutput = await fixture(context);
  const dataIndex = path.join(dataOutput, 'index.html');
  const html = await readFile(dataIndex, 'utf8');
  await writeFile(
    dataIndex,
    html.replace('</body>', '<img src="data:text/plain,blocked"></body>')
  );
  await assert.rejects(
    () => scanExport(dataOutput),
    /index\.html contains forbidden executable or embedded URI/
  );

  const remoteOutput = await fixture(context);
  const remoteIndex = path.join(remoteOutput, 'index.html');
  await writeFile(
    remoteIndex,
    html.replace('</body>', '<img src="//external.example/blocked"></body>')
  );
  await assert.rejects(
    () => scanExport(remoteOutput),
    /index\.html contains forbidden protocol-relative URL/
  );
});

test('rejects entity-encoded navigation that raw text scanning cannot see', async (context) => {
  const refreshOutput = await fixture(context);
  const refreshIndex = path.join(refreshOutput, 'index.html');
  const html = await readFile(refreshIndex, 'utf8');
  await writeFile(
    refreshIndex,
    html.replace(
      '</head>',
      '<meta http-equiv="refresh" content="0; url=h&#116;tps&#58;//repo&#46;usecannon&#46;com"></head>'
    )
  );
  await assert.rejects(
    () => scanExport(refreshOutput),
    /index\.html contains forbidden meta refresh/
  );

  const linkOutput = await fixture(context);
  const linkIndex = path.join(linkOutput, 'index.html');
  await writeFile(
    linkIndex,
    html.replace(
      '</body>',
      '<a href="h&#116;tps&#58;//repo&#46;usecannon&#46;com">legacy</a></body>'
    )
  );
  await assert.rejects(
    () => scanExport(linkOutput),
    /index\.html attribute a\[href\] contains forbidden decoded remote HTTP URL/
  );
});

test('rejects an undeclared export file', async (context) => {
  const output = await fixture(context);
  await writeFile(path.join(output, 'runtime.js'), 'void 0;\n');

  await assert.rejects(
    () => scanExport(output),
    /export file set is not allowlisted/
  );
});

test('rejects a symlink before reading its target', async (context) => {
  const output = await fixture(context);
  await symlink(
    path.join(output, 'index.html'),
    path.join(output, 'linked.html')
  );

  await assert.rejects(
    () => scanExport(output),
    /export contains a symbolic link/
  );
});

test('rejects asset tampering even when it adds no hosted dependency', async (context) => {
  const output = await fixture(context);
  const stylesheetPath = path.join(output, 'assets/app.css');
  const stylesheet = await readFile(stylesheetPath, 'utf8');
  await writeFile(
    stylesheetPath,
    `${stylesheet}\nbody { outline: 1px solid red; }\n`
  );

  await assert.rejects(
    () => scanExport(output),
    /release byte length mismatch: assets\/app\.css/
  );
});

test('rejects a weakened generated Cloudflare policy', async (context) => {
  const output = await fixture(context);
  const headersPath = path.join(output, '_headers');
  const headers = await readFile(headersPath, 'utf8');
  await writeFile(
    headersPath,
    headers.replace("connect-src 'none'", "connect-src 'self'")
  );

  await assert.rejects(
    () => scanExport(output),
    /Cloudflare headers do not match the generated policy/
  );
});

test('rejects release metadata whose config digest does not match its profile', async (context) => {
  const output = await fixture(context);
  const releasePath = path.join(output, 'release.json');
  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  release.build.configDigest = `sha256:${'0'.repeat(64)}`;
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);

  await assert.rejects(
    () => scanExport(output),
    /release config digest does not match the validated profile/
  );
});

test('rejects a deployed component hidden in the static SBOM', async (context) => {
  const output = await fixture(context);
  const sbomPath = path.join(output, 'sbom.cdx.json');
  const releasePath = path.join(output, 'release.json');
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  sbom.components.push({
    type: 'library',
    name: 'hidden-runtime',
    version: '1.0.0',
  });
  const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
  await writeFile(sbomPath, sbomBytes);

  const release = JSON.parse(await readFile(releasePath, 'utf8'));
  const entry = release.export.files.find(
    ({ path: relativePath }) => relativePath === 'sbom.cdx.json'
  );
  entry.bytes = sbomBytes.length;
  entry.digest = sha256(sbomBytes);
  const assets = await Promise.all(
    release.export.files.map(async ({ path: relativePath }) => ({
      path: relativePath,
      bytes: await readFile(path.join(output, relativePath)),
    }))
  );
  release.export.assetDigest = digestFiles(assets);
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);

  await assert.rejects(
    () => scanExport(output),
    /SBOM deployed components must be empty/
  );
});
