import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PRODUCTION_INGRESS_ORIGIN =
  'https://cannon-safe-staging.tailf2022c.ts.net';
const PRODUCTION_SITE_ORIGIN = 'https://cannon.reya.xyz';
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const output = path.join(packageRoot, 'out');
const workingOutput = path.join(packageRoot, '.out-build');
const require = createRequire(import.meta.url);

function required(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function localStagingEnabled() {
  const value = process.env.REYA_LOCAL_STAGING?.trim() || 'disabled';
  if (value !== 'disabled' && value !== 'enabled') {
    throw new Error(
      'REYA_LOCAL_STAGING must be exactly "disabled" or "enabled"'
    );
  }
  return value === 'enabled';
}

function profileConfig() {
  const profile = required('REYA_WEBSITE_PROFILE');
  if (profile !== 'local' && profile !== 'production') {
    throw new Error(
      'REYA_WEBSITE_PROFILE must be exactly "local" or "production"'
    );
  }
  const prefix = profile === 'local' ? 'REYA_LOCAL' : 'REYA_PRODUCTION';
  if (required(`${prefix}_PROFILE`) !== 'enabled') {
    throw new Error(`${prefix}_PROFILE must be enabled`);
  }
  const safeAddress = required(`${prefix}_SAFE_ADDRESS`);
  if (
    !ADDRESS_PATTERN.test(safeAddress) ||
    safeAddress === `0x${'0'.repeat(40)}`
  ) {
    throw new Error(`${prefix}_SAFE_ADDRESS is invalid`);
  }
  const sourceCommit = required(`${prefix}_SOURCE_COMMIT`);
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error(`${prefix}_SOURCE_COMMIT is invalid`);
  }
  const ingressOrigin = required(`${prefix}_INGRESS_ORIGIN`);
  const expectedIngress =
    profile === 'local' ? 'http://127.0.0.1:8787' : PRODUCTION_INGRESS_ORIGIN;
  if (ingressOrigin !== expectedIngress) {
    throw new Error(`${prefix}_INGRESS_ORIGIN is invalid`);
  }
  const siteOrigin =
    profile === 'local'
      ? 'http://127.0.0.1:3000'
      : required('REYA_PRODUCTION_SITE_ORIGIN');
  if (profile === 'production' && siteOrigin !== PRODUCTION_SITE_ORIGIN) {
    throw new Error('REYA_PRODUCTION_SITE_ORIGIN is invalid');
  }
  const stagingEnabled =
    profile === 'local'
      ? localStagingEnabled()
      : required('REYA_PRODUCTION_STAGING') === 'enabled';
  if (profile === 'production' && !stagingEnabled) {
    throw new Error('REYA_PRODUCTION_STAGING must be enabled');
  }
  return Object.freeze({
    chainId: 1729,
    ingressOrigin,
    profile,
    safeAddress,
    siteOrigin,
    sourceCommit,
    stagingEnabled,
  });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function buildCss() {
  const cli = require.resolve('tailwindcss/lib/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        '-c',
        path.join(packageRoot, 'tailwind.config.js'),
        '-i',
        path.join(packageRoot, '../website/src/styles/globals.css'),
        '-o',
        path.join(workingOutput, 'app.css'),
        '--minify',
      ],
      { stdio: 'inherit' }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error('Reya local CSS build failed'));
    });
  });
}

await Promise.all([
  rm(output, { force: true, recursive: true }),
  rm(workingOutput, { force: true, recursive: true }),
]);
try {
  const config = profileConfig();
  await mkdir(workingOutput, { recursive: true });

  await build({
    alias: {
      '@': path.join(packageRoot, '../website/src'),
      '@cannon': path.join(packageRoot, '../website/src'),
    },
    bundle: true,
    define: {
      __REYA_LOCAL_CONFIG__: JSON.stringify(config),
      global: 'globalThis',
    },
    entryPoints: [path.join(packageRoot, 'src/index.tsx')],
    format: 'iife',
    legalComments: 'none',
    logLevel: 'warning',
    minify: true,
    outfile: path.join(workingOutput, 'app.js'),
    platform: 'browser',
    sourcemap: false,
    target: ['chrome120', 'firefox120', 'safari17'],
  });
  await buildCss();

  const description =
    config.profile === 'production'
      ? 'Execution-disabled Cannon Safe proposal staging for Reya Network.'
      : 'Local, execution-disabled Cannon Safe proposal staging for Reya Network.';
  const csp = `default-src 'none'; base-uri 'none'; connect-src ${config.ingressOrigin}; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'`;
  const html = `<!doctype html>
<html class="dark" lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Reya Cannon Safe staging</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <link rel="stylesheet" href="/app.css">
    <script defer src="/app.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
  await writeFile(path.join(workingOutput, 'index.html'), html, {
    encoding: 'utf8',
    flag: 'wx',
  });
  if (config.profile === 'production') {
    const headers = `/*
  Cache-Control: no-store
  Content-Security-Policy: ${csp}
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
`;
    await writeFile(path.join(workingOutput, '_headers'), headers, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const assetNames = ['_headers', 'app.css', 'app.js', 'index.html'];
    const assets = Object.fromEntries(
      await Promise.all(
        assetNames.map(async (name) => [
          name,
          digest(await readFile(path.join(workingOutput, name))),
        ])
      )
    );
    const release = Object.freeze({
      assets,
      buildCommit: required('REYA_PRODUCTION_BUILD_COMMIT'),
      config,
      configDigest: digest(JSON.stringify(config)),
      schema: 'reya-cannon-safe-website-release/v1',
    });
    if (!COMMIT_PATTERN.test(release.buildCommit)) {
      throw new Error('REYA_PRODUCTION_BUILD_COMMIT is invalid');
    }
    await writeFile(
      path.join(workingOutput, 'release.json'),
      `${JSON.stringify(release, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
  }
  await rename(workingOutput, output);
} catch (error) {
  await Promise.all([
    rm(output, { force: true, recursive: true }),
    rm(workingOutput, { force: true, recursive: true }),
  ]);
  throw error;
}
