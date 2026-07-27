#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtureRoot = mkdtempSync(
  join(tmpdir(), 'cannon-expected-runtime-sbom-')
);

const runPnpm = (args) => {
  const result = spawnSync('pnpm', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true' },
  });
  assert.equal(
    result.status,
    0,
    `pnpm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
};

try {
  mkdirSync(join(fixtureRoot, 'packages/repo'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'packages/kept'), { recursive: true });
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'expected-runtime-sbom-fixture',
        private: true,
        packageManager: 'pnpm@10.11.0',
      },
      null,
      2
    )}\n`
  );
  assert.equal(
    runPnpm(['--version']).trim(),
    '10.11.0',
    'the adversarial fixture must use the runtime build pnpm version'
  );
  writeFileSync(
    join(fixtureRoot, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\npnpmfile: evil.cjs\nignorePnpmfile: false\n"
  );
  writeFileSync(
    join(fixtureRoot, 'packages/repo/package.json'),
    `${JSON.stringify(
      {
        name: '@usecannon/repo',
        version: '1.0.0',
        dependencies: {
          '@fixture/kept': 'workspace:*',
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(fixtureRoot, 'packages/kept/package.json'),
    `${JSON.stringify(
      {
        name: '@fixture/kept',
        version: '1.0.0',
      },
      null,
      2
    )}\n`
  );

  runPnpm([
    'install',
    '--lockfile-only',
    '--ignore-pnpmfile',
    '--ignore-scripts',
    '--no-optional',
  ]);

  const hookMarker = join(fixtureRoot, 'pnpm-hook-executed');
  const hookPath = join(fixtureRoot, 'evil.cjs');
  writeFileSync(
    hookPath,
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "writeFileSync(join(__dirname, 'pnpm-hook-executed'), 'executed\\n');",
      'module.exports = {',
      '  hooks: {',
      '    readPackage(pkg) {',
      "      if (pkg.name === '@usecannon/repo') pkg.dependencies = {};",
      '      return pkg;',
      '    },',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(fixtureRoot, '.npmrc'),
    ['ignore-pnpmfile=false', 'ignore-scripts=false', 'optional=true', ''].join(
      '\n'
    )
  );

  runPnpm([
    '--filter',
    '@usecannon/repo...',
    'install',
    '--frozen-lockfile',
    '--ignore-pnpmfile',
    '--ignore-scripts',
    '--no-optional',
  ]);
  assert.equal(
    existsSync(hookMarker),
    false,
    'the source-controlled pnpm hook must not execute'
  );
  assert.equal(
    existsSync(
      join(fixtureRoot, 'packages/repo/node_modules/@fixture/kept/package.json')
    ),
    true,
    'the ignored hook must not prune a dependency from the expected closure'
  );

  const list = JSON.parse(
    runPnpm([
      '--config.ignore-pnpmfile=true',
      '--filter',
      '@usecannon/repo',
      'list',
      '--prod',
      '--no-optional',
      '--depth',
      'Infinity',
      '--json',
    ])
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '@usecannon/repo');
  assert.equal(
    existsSync(hookMarker),
    false,
    'the custom workspace pnpm hook must remain ignored during list'
  );
  assert.equal(
    existsSync(hookPath),
    true,
    'the adversarial custom-named hook must remain present through list'
  );
  assert.ok(
    readFileSync(
      join(
        fixtureRoot,
        'packages/repo/node_modules/@fixture/kept/package.json'
      ),
      'utf8'
    ).includes('"@fixture/kept"')
  );
  assert.ok(
    list[0].dependencies['@fixture/kept'],
    'the listed production closure must retain the dependency'
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Expected runtime SBOM pnpm-hook isolation test passed.');
