import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('retains the dark theme used by the exported document', async () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/build-reya-local-profile.mjs')], {
      encoding: 'utf8',
      env: {
        REYA_LOCAL_INGRESS_ORIGIN: 'http://127.0.0.1:8787',
        REYA_LOCAL_PROFILE: 'enabled',
        REYA_LOCAL_SAFE_ADDRESS: '0x1111111111111111111111111111111111111111',
        REYA_LOCAL_SOURCE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
        REYA_LOCAL_STAGING: 'enabled',
        REYA_WEBSITE_PROFILE: 'local',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const [css, html] = await Promise.all([
      readFile(path.join(output, 'app.css'), 'utf8'),
      readFile(path.join(output, 'index.html'), 'utf8'),
    ]);
    expect(html).toContain('<html class="dark"');
    expect(css).toContain('.dark{--background:240 10% 3.9%');
    expect(css).toContain('.text-primary-foreground{color:hsl(var(--primary-foreground))}');
  });

  it('removes stale and partial exports when configuration fails', async () => {
    await Promise.all([mkdir(output, { recursive: true }), mkdir(workingOutput, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(output, 'stale'), 'stale'),
      writeFile(path.join(workingOutput, 'partial'), 'partial'),
    ]);

    const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/build-reya-local-profile.mjs')], {
      encoding: 'utf8',
      env: {
        REYA_LOCAL_PROFILE: 'enabled',
        REYA_WEBSITE_PROFILE: 'local',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REYA_LOCAL_SAFE_ADDRESS is required');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(workingOutput)).toBe(false);
  });

  it('emits a production Pages export with immutable release evidence', async () => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/build-reya-local-profile.mjs')], {
      encoding: 'utf8',
      env: {
        REYA_PRODUCTION_BUILD_COMMIT: '89abcdef0123456789abcdef0123456789abcdef',
        REYA_PRODUCTION_INGRESS_ORIGIN: 'https://cannon-safe-staging.tailf2022c.ts.net',
        REYA_PRODUCTION_PROFILE: 'enabled',
        REYA_PRODUCTION_SAFE_ADDRESS: '0x1fe50318e5e3165742edc9c4a15d997bdb935eb9',
        REYA_PRODUCTION_SITE_ORIGIN: 'https://cannon.reya.xyz',
        REYA_PRODUCTION_SOURCE_COMMIT: '2b10669075b91eb8db781d199292f30c52f8e994',
        REYA_PRODUCTION_STAGING: 'enabled',
        REYA_WEBSITE_PROFILE: 'production',
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const [headers, html, releaseText] = await Promise.all([
      readFile(path.join(output, '_headers'), 'utf8'),
      readFile(path.join(output, 'index.html'), 'utf8'),
      readFile(path.join(output, 'release.json'), 'utf8'),
    ]);
    expect(headers).toContain('connect-src https://cannon-safe-staging.tailf2022c.ts.net');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(html).toContain('connect-src https://cannon-safe-staging.tailf2022c.ts.net');
    expect(JSON.parse(releaseText)).toMatchObject({
      buildCommit: '89abcdef0123456789abcdef0123456789abcdef',
      config: {
        profile: 'production',
        siteOrigin: 'https://cannon.reya.xyz',
        stagingEnabled: true,
      },
      schema: 'reya-cannon-safe-website-release/v1',
    });
  });
});
