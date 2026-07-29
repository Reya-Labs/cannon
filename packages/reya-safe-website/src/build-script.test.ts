import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(packageRoot, 'out');
const workingOutput = path.join(packageRoot, '.out-build');

afterEach(async () => {
  await Promise.all([rm(output, { force: true, recursive: true }), rm(workingOutput, { force: true, recursive: true })]);
});

describe('local profile build', () => {
  it('removes stale and partial exports when configuration fails', async () => {
    await Promise.all([mkdir(output, { recursive: true }), mkdir(workingOutput, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(output, 'stale'), 'stale'),
      writeFile(path.join(workingOutput, 'partial'), 'partial'),
    ]);

    const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/build-reya-local-profile.mjs')], {
      encoding: 'utf8',
      env: { REYA_LOCAL_PROFILE: 'enabled' },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REYA_LOCAL_SAFE_ADDRESS is required');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(workingOutput)).toBe(false);
  });
});
