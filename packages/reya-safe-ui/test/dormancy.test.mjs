import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  scanForbiddenSourceDomains,
  verifyDormantClients,
} from '../scripts/verify-dormant-clients.mjs';

test('proves the disabled static shell cannot reach the service clients', async () => {
  const result = await verifyDormantClients();

  assert.deepEqual(result.active, ['build.mjs', 'config.mjs', 'template.mjs']);
  assert.deepEqual(result.dormant, [
    'clients/artifacts.mjs',
    'clients/config.mjs',
    'clients/errors.mjs',
    'clients/index.mjs',
    'clients/query.mjs',
    'clients/rpc.mjs',
    'clients/schema.mjs',
    'clients/source.mjs',
    'clients/staging.mjs',
    'clients/transport.mjs',
  ]);
  assert.equal(
    result.active.some((file) => file.startsWith('clients/')),
    false
  );
  assert.equal(result.scanned.includes('clients/index.mjs'), true);
});

test('dormancy proof rejects a direct or dynamic client import', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-dormancy-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const clients = path.join(temporary, 'clients');
  await mkdir(clients);
  await writeFile(
    path.join(clients, 'index.mjs'),
    'export const dormant = true;\n'
  );

  for (const source of [
    "import './clients/index.mjs';\n",
    "import'./clients/index.mjs';\n",
    "import/* reviewed? */'./clients/index.mjs';\n",
    "await import('./clients/index.mjs');\n",
  ]) {
    await writeFile(path.join(temporary, 'build.mjs'), source);
    await assert.rejects(
      () =>
        verifyDormantClients({
          activeEntry: path.join(temporary, 'build.mjs'),
          dormantRoot: clients,
          sourceRoot: temporary,
        }),
      /disabled shell imports dormant client source/
    );
  }
});

test('dormancy proof rejects imports outside the reviewed relative graph', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-import-scope-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const clients = path.join(temporary, 'clients');
  await mkdir(clients);
  await writeFile(
    path.join(clients, 'index.mjs'),
    'export const dormant = true;\n'
  );

  for (const source of [
    "import 'unreviewed-package';\n",
    "import '/absolute/module.mjs';\n",
    "import 'file:///tmp/module.mjs';\n",
  ]) {
    await writeFile(path.join(temporary, 'build.mjs'), source);
    await assert.rejects(
      () =>
        verifyDormantClients({
          activeEntry: path.join(temporary, 'build.mjs'),
          dormantRoot: clients,
          sourceRoot: temporary,
        }),
      /unsupported non-relative import/
    );
  }

  await writeFile(
    path.join(temporary, 'build.mjs'),
    "import { execFile } from 'node:child_process';\nvoid execFile;\n"
  );
  await assert.rejects(
    () =>
      verifyDormantClients({
        activeEntry: path.join(temporary, 'build.mjs'),
        dormantRoot: clients,
        sourceRoot: temporary,
      }),
    /unsupported Node import/
  );
});

test('dormancy proof rejects non-static code loaders in the active graph', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-dynamic-loader-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const clients = path.join(temporary, 'clients');
  await mkdir(clients);
  await writeFile(
    path.join(clients, 'index.mjs'),
    'export const dormant = true;\n'
  );
  await writeFile(
    path.join(temporary, 'build.mjs'),
    "const load = require('./clients/index.mjs');\n"
  );

  await assert.rejects(
    () =>
      verifyDormantClients({
        activeEntry: path.join(temporary, 'build.mjs'),
        dormantRoot: clients,
        sourceRoot: temporary,
      }),
    /active Reya Safe UI graph has a dynamic code loader/
  );

  await writeFile(
    path.join(temporary, 'build.mjs'),
    "const target = './clients/index.mjs';\nawait import(target);\n"
  );
  await assert.rejects(
    () =>
      verifyDormantClients({
        activeEntry: path.join(temporary, 'build.mjs'),
        dormantRoot: clients,
        sourceRoot: temporary,
      }),
    /active Reya Safe UI graph has a non-literal import/
  );
});

test('source scan rejects hosted fallbacks, credentials, writes, and browser persistence', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-source-scan-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));

  const forbidden = [
    "export const endpoint = 'https://repo.usecannon.com';\n",
    "export const endpoint = 'https://gateway.pinata.cloud';\n",
    "export const endpoint = 'https://mainnet.infura.io';\n",
    "export const endpoint = 'https://github.com/reya/example';\n",
    "export const state = localStorage.getItem('origin');\n",
    "export const upload = '/api/v0/add';\n",
    "export const header = 'Bearer secret';\n",
  ];

  for (const [index, source] of forbidden.entries()) {
    const file = path.join(temporary, `forbidden-${index}.mjs`);
    await writeFile(file, source);
    await assert.rejects(
      () => scanForbiddenSourceDomains({ sourceRoot: temporary }),
      /contains forbidden/
    );
    await rm(file);
  }
});

test('source scan rejects any hard-coded remote origin, including an internal-looking one', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-hard-coded-origin-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  await writeFile(
    path.join(temporary, 'client.mjs'),
    "export const origin = 'https://cannon-api.example.ts.net';\n"
  );

  await assert.rejects(
    () => scanForbiddenSourceDomains({ sourceRoot: temporary }),
    /forbidden hard-coded remote URL/
  );
});

test('source scan rejects unreviewed source file types', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-safe-ui-source-type-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  await writeFile(
    path.join(temporary, 'fallback.js'),
    'export default true;\n'
  );

  await assert.rejects(
    () => scanForbiddenSourceDomains({ sourceRoot: temporary }),
    /unsupported UI source file/
  );
});
