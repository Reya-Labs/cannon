import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
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

function stagingEnabled() {
  const value = process.env.REYA_LOCAL_STAGING?.trim() || 'disabled';
  if (value !== 'disabled' && value !== 'enabled') {
    throw new Error(
      'REYA_LOCAL_STAGING must be exactly "disabled" or "enabled"'
    );
  }
  return value === 'enabled';
}

function profileConfig() {
  if (required('REYA_LOCAL_PROFILE') !== 'enabled') {
    throw new Error('REYA_LOCAL_PROFILE must be enabled');
  }
  const safeAddress = required('REYA_LOCAL_SAFE_ADDRESS');
  if (
    !ADDRESS_PATTERN.test(safeAddress) ||
    safeAddress === `0x${'0'.repeat(40)}`
  ) {
    throw new Error('REYA_LOCAL_SAFE_ADDRESS is invalid');
  }
  const sourceCommit = required('REYA_LOCAL_SOURCE_COMMIT');
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('REYA_LOCAL_SOURCE_COMMIT is invalid');
  }
  const ingressOrigin = required('REYA_LOCAL_INGRESS_ORIGIN');
  if (ingressOrigin !== 'http://127.0.0.1:8787') {
    throw new Error('REYA_LOCAL_INGRESS_ORIGIN is invalid');
  }
  return Object.freeze({
    chainId: 1729,
    ingressOrigin,
    safeAddress,
    sourceCommit,
    stagingEnabled: stagingEnabled(),
  });
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

  const html = `<!doctype html>
<html class="dark" lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Reya Cannon Safe staging</title>
    <meta name="description" content="Local, execution-disabled Cannon Safe proposal staging for Reya Network.">
    <meta name="robots" content="noindex,nofollow,noarchive">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src http://127.0.0.1:8787; font-src 'self'; form-action 'none'; img-src 'self' data:; manifest-src 'none'; object-src 'none'; script-src 'self'; style-src 'self'">
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
  await rename(workingOutput, output);
} catch (error) {
  await Promise.all([
    rm(output, { force: true, recursive: true }),
    rm(workingOutput, { force: true, recursive: true }),
  ]);
  throw error;
}
