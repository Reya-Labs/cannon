import { spawnSync } from 'node:child_process';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scanner = path.join(packageRoot, 'scripts/scan-reya-local-profile.mjs');
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { force: true, recursive: true })));
});

async function validFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reya-profile-scan-'));
  fixtures.push(root);
  await Promise.all([
    writeFile(root + '/app.css', 'body{}'),
    writeFile(
      root + '/app.js',
      'Local canary only; Sign and stage local proposal; PREVIEW_CHANGED_REVIEW_REQUIRED; eth_signTypedData_v4; Execution and broadcast remain unavailable'
    ),
    writeFile(
      root + '/index.html',
      "Reya Cannon Safe staging Content-Security-Policy http://127.0.0.1:8787 script-src 'self'"
    ),
  ]);
  return root;
}

function scan(root: string) {
  return spawnSync(process.execPath, [scanner, root], {
    encoding: 'utf8',
  });
}

describe('local profile export scanner', () => {
  it('accepts only the exact expected static export', async () => {
    const result = scan(await validFixture());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validated Reya local profile export');
  });

  it('rejects a forbidden hosted capability', async () => {
    const root = await validFixture();
    await writeFile(root + '/app.js', 'https://api.usecannon.com');

    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('forbidden capability');
  });

  it('rejects execution, broadcast and broadened staging capabilities', async () => {
    for (const capability of [
      '/staging/1/0x1111111111111111111111111111111111111111',
      '/staging/1729/0x1111111111111111111111111111111111111111/supersede',
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'execTransaction',
      'personal_sign',
      'wallet_switchEthereumChain',
    ]) {
      const root = await validFixture();
      await writeFile(root + '/app.js', capability);

      const result = scan(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('forbidden capability');
    }
  });

  it('rejects a symlinked required asset', async () => {
    const root = await validFixture();
    await rm(root + '/app.css');
    await symlink(root + '/app.js', root + '/app.css');

    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('symlink');
  });

  it('rejects source maps and all other undeclared root files', async () => {
    const root = await validFixture();
    await writeFile(root + '/app.js.map', '{}');

    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('browser source maps');
  });

  it('rejects oversized assets', async () => {
    const root = await validFixture();
    const handle = await open(root + '/app.js', 'w');
    await handle.truncate(32 * 1024 * 1024 + 1);
    await handle.close();

    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpectedly large');
  });

  it('rejects an index without the required security evidence', async () => {
    const root = await validFixture();
    await writeFile(root + '/index.html', '<html></html>');

    const result = scan(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('index is missing');
  });
});
