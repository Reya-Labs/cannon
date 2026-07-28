#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'cannon-artifact-release-'));
const packDirectory = join(temporaryRoot, 'packs');
const consumerDirectory = join(temporaryRoot, 'consumer');
const consumerStoreDirectory = join(temporaryRoot, 'pnpm-store');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

mkdirSync(packDirectory, { recursive: true });
mkdirSync(consumerDirectory, { recursive: true });

let publicationHead;
let publicationStatus;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, CI: 'true', ...options.env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} exited ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return result.stdout.trim();
}

function runPnpm(args, options) {
  return run(pnpm, args, options);
}

function cleanGeneratedOutput() {
  for (const packageName of [
    '@usecannon/artifact-codec',
    '@usecannon/builder',
    '@usecannon/cli',
    'hardhat-cannon',
    '@usecannon/repo',
  ]) {
    runPnpm(['--filter', packageName, 'run', 'clean']);
  }
  rmSync(join(repositoryRoot, 'packages/builder/coverage'), {
    recursive: true,
    force: true,
  });
}

function findTarball(packageFragment) {
  const matches = readdirSync(packDirectory)
    .filter((name) => name.endsWith('.tgz') && name.includes(packageFragment))
    .map((name) => join(packDirectory, name));
  assert.equal(
    matches.length,
    1,
    `expected one ${packageFragment} tarball, found ${matches.length}`
  );
  return matches[0];
}

function readPackedManifest(tarball) {
  return JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
}

function assertExists(relativePath) {
  assert.ok(
    existsSync(join(repositoryRoot, relativePath)),
    `${relativePath} was not generated`
  );
}

function hasCoupledMajorIntent(source) {
  const lines = source.split(/\r?\n/u);
  if (lines[0] !== '---') return false;

  const closingDelimiter = lines.indexOf('---', 1);
  if (closingDelimiter === -1) return false;

  const releaseTypes = new Map();
  for (const line of lines.slice(1, closingDelimiter)) {
    const match = line.match(
      /^(['"])(?<packageName>[^'"]+)\1:\s*(?<releaseType>major|minor|patch)\s*$/u
    );
    if (!match?.groups) continue;
    if (releaseTypes.has(match.groups.packageName)) return false;
    releaseTypes.set(match.groups.packageName, match.groups.releaseType);
  }

  return (
    releaseTypes.get('@usecannon/artifact-codec') === 'major' &&
    releaseTypes.get('@usecannon/builder') === 'major'
  );
}

function buildConsumerRuntimeCheck(expectedCid, expectedVersion) {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const codec = require('@usecannon/artifact-codec');",
    "const builder = require('@usecannon/builder');",
    `const expected = ${JSON.stringify(expectedCid)};`,
    `const expectedVersion = ${JSON.stringify(expectedVersion)};`,
    'function readInstalledManifest(packageName) {',
    '  let directory = path.dirname(require.resolve(packageName));',
    '  while (directory !== path.dirname(directory)) {',
    "    const manifestPath = path.join(directory, 'package.json');",
    '    if (fs.existsSync(manifestPath)) {',
    "      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
    '      if (manifest.name === packageName) return manifest;',
    '    }',
    '    directory = path.dirname(directory);',
    '  }',
    '  throw new Error(`could not resolve installed manifest for ${packageName}`);',
    '}',
    "for (const packageName of ['@usecannon/artifact-codec', '@usecannon/builder', '@usecannon/cli', 'hardhat-cannon']) {",
    '  const manifest = readInstalledManifest(packageName);',
    '  if (manifest.version !== expectedVersion) {',
    '    throw new Error(`${packageName} resolved ${manifest.version}; expected ${expectedVersion}`);',
    '  }',
    '}',
    "Promise.all([codec.getContentCID(Buffer.from('hello world')), builder.getContentCID(Buffer.from('hello world'))])",
    '  .then(([codecCid, builderCid]) => {',
    '    if (codecCid !== expected || builderCid !== expected) {',
    '      throw new Error(`artifact CID mismatch: ${codecCid} ${builderCid}; expected ${expected}`);',
    '    }',
    '  })',
    '  .catch((error) => {',
    '    console.error(error);',
    '    process.exitCode = 1;',
    '  });',
  ].join('\n');
}

function selectReleaseFailure(primaryError, cleanupErrors) {
  if (primaryError !== undefined) return primaryError;
  if (cleanupErrors.length === 0) return undefined;
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  return new AggregateError(
    cleanupErrors,
    'release verification cleanup failed'
  );
}

{
  const primaryFailureProbe = new Error('primary release failure probe');
  const cleanupFailureProbe = new Error('cleanup failure probe');
  assert.equal(
    selectReleaseFailure(primaryFailureProbe, [cleanupFailureProbe]),
    primaryFailureProbe,
    'cleanup failures must not replace the primary release-contract failure'
  );
  assert.equal(
    selectReleaseFailure(undefined, [cleanupFailureProbe]),
    cleanupFailureProbe,
    'cleanup failures must propagate when the release contract succeeded'
  );
}

let primaryError;
try {
  const verifierArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== '--');
  assert.deepEqual(
    verifierArguments.filter((argument) => argument !== '--require-versioned'),
    [],
    'unsupported release-contract argument'
  );
  const requireVersioned = verifierArguments.includes('--require-versioned');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.ok(
    nodeMajor >= 20,
    `release contract requires Node 20+, received ${process.versions.node}`
  );
  if (requireVersioned) {
    publicationHead = run('git', ['rev-parse', '--verify', 'HEAD']);
    assert.match(
      publicationHead,
      /^[0-9a-f]{40}$/u,
      'publication requires a full Git commit identity'
    );
    publicationStatus = run('git', [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    assert.equal(
      publicationStatus,
      '',
      'publication requires a clean tracked and untracked worktree'
    );
  }

  const sourceCodecManifest = JSON.parse(
    readFileSync(
      join(repositoryRoot, 'packages/artifact-codec/package.json'),
      'utf8'
    )
  );
  const sourceBuilderManifest = JSON.parse(
    readFileSync(join(repositoryRoot, 'packages/builder/package.json'), 'utf8')
  );
  assert.equal(
    sourceBuilderManifest.version,
    sourceCodecManifest.version,
    'source codec and builder versions must remain aligned'
  );
  const changesetConfig = JSON.parse(
    readFileSync(join(repositoryRoot, '.changeset/config.json'), 'utf8')
  );
  const artifactFixedGroups = changesetConfig.fixed.filter(
    (group) =>
      group.includes('@usecannon/artifact-codec') &&
      group.includes('@usecannon/builder')
  );
  assert.equal(
    artifactFixedGroups.length,
    1,
    'Changesets must version the codec and builder in exactly one fixed group'
  );
  const workspaceManifests = new Map(
    readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        join(repositoryRoot, 'packages', entry.name, 'package.json')
      )
      .filter((manifestPath) => existsSync(manifestPath))
      .map((manifestPath) => {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return [manifest.name, manifest];
      })
  );
  for (const packageName of artifactFixedGroups[0]) {
    const manifest = workspaceManifests.get(packageName);
    assert.ok(manifest, `${packageName} must be a workspace package`);
    assert.equal(
      manifest.version,
      sourceCodecManifest.version,
      `${packageName} must share the artifact fixed-group source version`
    );
    assert.equal(
      manifest.engines?.node,
      '>=20.0.0',
      `${packageName} must declare the Cannon v3 Node 20 floor`
    );
    assert.equal(
      Object.hasOwn(manifest, 'engineStrict'),
      false,
      `${packageName} must not claim ineffective package-level engine enforcement`
    );
  }
  const sourceMajor = Number(sourceCodecManifest.version.split('.')[0]);
  assert.ok(
    Number.isInteger(sourceMajor) && sourceMajor >= 0,
    `invalid codec version ${sourceCodecManifest.version}`
  );
  assert.equal(
    hasCoupledMajorIntent(
      [
        '---',
        "'@usecannon/artifact-codec': patch",
        "'@usecannon/builder': patch",
        '---',
        "'@usecannon/artifact-codec': major",
        "'@usecannon/builder': major",
      ].join('\n')
    ),
    false,
    'major declarations in a changeset body must not satisfy release intent'
  );
  const hasPendingMajorIntent = readdirSync(join(repositoryRoot, '.changeset'))
    .filter((name) => name.endsWith('.md'))
    .some((name) => {
      const source = readFileSync(
        join(repositoryRoot, '.changeset', name),
        'utf8'
      );
      return hasCoupledMajorIntent(source);
    });
  if (sourceMajor < 3) {
    assert.ok(
      hasPendingMajorIntent,
      'the Node 20 floor requires a coupled Cannon v3 major changeset'
    );
  }
  if (requireVersioned) {
    assert.ok(
      sourceMajor >= 3,
      'publication is blocked until the Cannon v3 major version is applied'
    );
  }

  const trackedDist = run('git', [
    'ls-files',
    '--',
    'packages/artifact-codec/dist/**',
    'packages/artifact-codec/.build/**',
    'packages/builder/dist/**',
    'packages/cli/dist/**',
    'packages/hardhat-cannon/dist/**',
    'packages/repo/dist/**',
  ]);
  assert.equal(
    trackedDist,
    '',
    'generated consumer output must not be committed'
  );

  cleanGeneratedOutput();
  assert.equal(
    existsSync(join(repositoryRoot, 'packages/artifact-codec/dist')),
    false
  );
  assert.equal(
    existsSync(join(repositoryRoot, 'packages/builder/dist')),
    false
  );
  assert.equal(existsSync(join(repositoryRoot, 'packages/cli/dist')), false);
  assert.equal(
    existsSync(join(repositoryRoot, 'packages/hardhat-cannon/dist')),
    false
  );
  assert.equal(existsSync(join(repositoryRoot, 'packages/repo/dist')), false);

  // These commands intentionally start from a missing codec dist directory.
  runPnpm([
    '--filter',
    '@usecannon/builder',
    'run',
    'test',
    '--',
    'src/ipfs-codec.test.ts',
    '--runInBand',
  ]);
  assertExists('packages/artifact-codec/dist/index.js');
  runPnpm(['--filter', '@usecannon/artifact-codec', 'run', 'clean']);
  runPnpm(['--filter', '@usecannon/builder', 'run', 'clean']);

  runPnpm(['--filter', '@usecannon/builder', 'run', 'build:node']);
  assertExists('packages/artifact-codec/dist/index.js');
  assertExists('packages/artifact-codec/dist/index.d.ts');
  assertExists('packages/builder/dist/src/index.js');

  runPnpm(['--filter', '@usecannon/artifact-codec', 'run', 'clean']);
  runPnpm(['--filter', '@usecannon/builder', 'run', 'clean']);
  runPnpm(['--filter', '@usecannon/builder', 'run', 'build:browser']);
  assertExists('packages/builder/dist/cannon.umd.js');

  runPnpm(['--filter', '@usecannon/artifact-codec', 'run', 'clean']);
  runPnpm(['--filter', '@usecannon/repo', 'run', 'clean']);
  runPnpm(['--filter', '@usecannon/repo', 'run', 'build']);
  assertExists('packages/repo/dist/src/index.js');

  // Simulate the worst partial-publish retry: every earlier fixed-group package
  // is already public and Lerna would skip its lifecycle scripts.
  cleanGeneratedOutput();
  runPnpm(['run', 'prepare:artifact-release']);
  assertExists('packages/artifact-codec/dist/index.js');
  assertExists('packages/builder/dist/src/index.js');
  assertExists('packages/cli/dist/src/index.js');
  assertExists('packages/hardhat-cannon/dist/index.js');

  runPnpm([
    '--filter',
    '@usecannon/artifact-codec',
    'pack',
    '--pack-destination',
    packDirectory,
  ]);
  runPnpm([
    '--filter',
    '@usecannon/builder',
    'pack',
    '--pack-destination',
    packDirectory,
  ]);
  runPnpm([
    '--filter',
    '@usecannon/cli',
    'pack',
    '--pack-destination',
    packDirectory,
  ]);
  runPnpm([
    '--filter',
    'hardhat-cannon',
    'pack',
    '--pack-destination',
    packDirectory,
  ]);

  const codecTarball = findTarball('artifact-codec');
  const builderTarball = findTarball('builder');
  const cliTarball = findTarball('cli');
  const hardhatTarball = findTarball('hardhat-cannon');
  const codecManifest = readPackedManifest(codecTarball);
  const builderManifest = readPackedManifest(builderTarball);
  const cliManifest = readPackedManifest(cliTarball);
  const hardhatManifest = readPackedManifest(hardhatTarball);

  assert.equal(codecManifest.name, '@usecannon/artifact-codec');
  assert.equal(builderManifest.name, '@usecannon/builder');
  assert.equal(cliManifest.name, '@usecannon/cli');
  assert.equal(hardhatManifest.name, 'hardhat-cannon');
  assert.equal(codecManifest.version, sourceCodecManifest.version);
  assert.equal(builderManifest.version, sourceBuilderManifest.version);
  assert.notEqual(codecManifest.private, true);
  assert.equal(codecManifest.license, 'MIT');
  for (const manifest of [
    codecManifest,
    builderManifest,
    cliManifest,
    hardhatManifest,
  ]) {
    assert.equal(manifest.version, codecManifest.version);
    assert.equal(manifest.engines?.node, '>=20.0.0');
    assert.equal(
      Object.hasOwn(manifest, 'engineStrict'),
      false,
      `${manifest.name} must not publish the ineffective engineStrict field`
    );
  }
  assert.equal(codecManifest.publishConfig?.access, 'public');
  assert.equal(
    builderManifest.dependencies?.['@usecannon/artifact-codec'],
    codecManifest.version,
    'pnpm pack must rewrite the builder workspace dependency to the exact codec version'
  );
  assert.equal(
    cliManifest.dependencies?.['@usecannon/builder'],
    codecManifest.version,
    'pnpm pack must rewrite the CLI workspace dependency to the exact builder version'
  );
  assert.equal(
    hardhatManifest.dependencies?.['@usecannon/builder'],
    codecManifest.version,
    'pnpm pack must rewrite the Hardhat workspace dependency to the exact builder version'
  );
  assert.equal(
    hardhatManifest.dependencies?.['@usecannon/cli'],
    codecManifest.version,
    'pnpm pack must rewrite the Hardhat workspace dependency to the exact CLI version'
  );

  const codecContents = run('tar', ['-tzf', codecTarball])
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual(codecContents, [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/package.json',
  ]);
  assert.equal(
    run('tar', ['-xOf', codecTarball, 'package/LICENSE']),
    readFileSync(
      join(repositoryRoot, 'packages/artifact-codec/LICENSE'),
      'utf8'
    ).trim(),
    'the packed MIT license must be the package-local license'
  );

  const packageOrder = JSON.parse(
    runPnpm(['exec', 'lerna', 'list', '--toposort', '--json', '--all'])
  ).map(({ name }) => name);
  const codecOrder = packageOrder.indexOf('@usecannon/artifact-codec');
  const builderOrder = packageOrder.indexOf('@usecannon/builder');
  const cliOrder = packageOrder.indexOf('@usecannon/cli');
  const hardhatOrder = packageOrder.indexOf('hardhat-cannon');
  assert.notEqual(codecOrder, -1, 'Lerna must include the codec');
  assert.notEqual(builderOrder, -1, 'Lerna must include the builder');
  assert.notEqual(cliOrder, -1, 'Lerna must include the CLI');
  assert.notEqual(hardhatOrder, -1, 'Lerna must include the Hardhat plugin');
  assert.ok(
    codecOrder < builderOrder &&
      builderOrder < cliOrder &&
      cliOrder < hardhatOrder,
    'Lerna must preserve codec -> builder -> CLI -> Hardhat dependency order'
  );

  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, 'package.json'), 'utf8')
  );
  assert.equal(
    Object.hasOwn(rootPackage, 'engineStrict'),
    false,
    'the root manifest must not claim ineffective package-level engine enforcement'
  );
  assert.equal(
    rootPackage.scripts['prepare:artifact-release'],
    'pnpm -r --filter @usecannon/artifact-codec --filter @usecannon/builder --filter @usecannon/cli --filter hardhat-cannon run clean && pnpm -r --filter @usecannon/artifact-codec --filter @usecannon/builder --filter @usecannon/cli --filter hardhat-cannon run build',
    'the retry-safe release preparation must clean and rebuild the complete fixed group'
  );
  for (const scriptName of ['publish', 'publish-alpha']) {
    const script = rootPackage.scripts[scriptName];
    assert.match(
      script,
      /^pnpm run verify:artifact-release -- --require-versioned && pnpm run prepare:artifact-release && lerna publish from-package/u
    );
    assert.match(script, /--concurrency 1/u);
    assert.match(script, /--reject-cycles/u);
    assert.match(script, /--graph-type dependencies/u);
    assert.doesNotMatch(script, /--no-sort/u);
  }
  assert.doesNotMatch(
    rootPackage.scripts['publish-alpha'],
    /--preid/u,
    'from-package publishes manifest versions and must not pretend to calculate a prerelease'
  );
  assert.match(rootPackage.scripts['publish-alpha'], /--dist-tag alpha/u);

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cannon-artifact-release-contract',
        private: true,
        version: '0.0.0',
        packageManager: rootPackage.packageManager,
        dependencies: {
          '@usecannon/artifact-codec': `file:${codecTarball}`,
          '@usecannon/builder': `file:${builderTarball}`,
          '@usecannon/cli': `file:${cliTarball}`,
          'hardhat-cannon': `file:${hardhatTarball}`,
          hardhat: '2.22.19',
        },
        pnpm: {
          overrides: {
            [`@usecannon/artifact-codec@${codecManifest.version}`]: `file:${codecTarball}`,
            [`@usecannon/builder@${builderManifest.version}`]: `file:${builderTarball}`,
            [`@usecannon/cli@${cliManifest.version}`]: `file:${cliTarball}`,
            [`hardhat-cannon@${hardhatManifest.version}`]: `file:${hardhatTarball}`,
          },
        },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(consumerDirectory, 'index.ts'),
    [
      "import { getContentCID as codecCid } from '@usecannon/artifact-codec';",
      "import { getContentCID as builderCid } from '@usecannon/builder';",
      'void Promise.all([codecCid(new Uint8Array()), builderCid(new Uint8Array())]);',
      '',
    ].join('\n')
  );

  const consumerInstallArgs = [
    'install',
    '--ignore-scripts',
    '--config.engine-strict=true',
    '--store-dir',
    consumerStoreDirectory,
  ];
  runPnpm(consumerInstallArgs, { cwd: consumerDirectory });
  rmSync(join(consumerDirectory, 'node_modules'), {
    recursive: true,
    force: true,
  });
  runPnpm([...consumerInstallArgs, '--offline', '--frozen-lockfile'], {
    cwd: consumerDirectory,
  });
  run(
    join(repositoryRoot, 'node_modules/.bin/tsc'),
    [
      '--strict',
      '--module',
      'commonjs',
      '--target',
      'es2021',
      '--moduleResolution',
      'node',
      '--skipLibCheck',
      '--noEmit',
      'index.ts',
    ],
    {
      cwd: consumerDirectory,
    }
  );
  const runtimeExpectedCid = 'Qmf412jQZiuVUtdgnB36FXFX7xg5V6KEbSJ4dpQuhkLyfD';
  const rejectionWarningEnvironment = {
    NODE_OPTIONS: '--unhandled-rejections=warn',
  };
  run(
    process.execPath,
    [
      '-e',
      buildConsumerRuntimeCheck(runtimeExpectedCid, codecManifest.version),
    ],
    {
      cwd: consumerDirectory,
      env: rejectionWarningEnvironment,
    }
  );
  assert.throws(
    () =>
      run(
        process.execPath,
        [
          '-e',
          buildConsumerRuntimeCheck(
            'invalid-regression-probe',
            codecManifest.version
          ),
        ],
        {
          cwd: consumerDirectory,
          env: rejectionWarningEnvironment,
        }
      ),
    /exited 1[\s\S]*artifact CID mismatch/u,
    'a CID mismatch must fail explicitly even when unhandled rejections only warn'
  );
} catch (error) {
  primaryError = error;
}

const cleanupErrors = [];
const cleanupSteps = [
  ['generated output cleanup', cleanGeneratedOutput],
  [
    'temporary release directory cleanup',
    () => rmSync(temporaryRoot, { recursive: true, force: true }),
  ],
];
if (publicationHead !== undefined) {
  cleanupSteps.push(
    [
      'release HEAD re-verification',
      () =>
        assert.equal(
          run('git', ['rev-parse', '--verify', 'HEAD']),
          publicationHead,
          'release verification must remain bound to one Git commit'
        ),
    ],
    [
      'release worktree re-verification',
      () =>
        assert.equal(
          run('git', ['status', '--porcelain=v1', '--untracked-files=all']),
          publicationStatus,
          'release verification lifecycle scripts must not mutate publish inputs'
        ),
    ]
  );
}

for (const [label, cleanup] of cleanupSteps) {
  try {
    cleanup();
  } catch (error) {
    cleanupErrors.push(
      new Error(`${label} failed`, {
        cause: error,
      })
    );
  }
}

if (primaryError !== undefined && cleanupErrors.length > 0) {
  for (const cleanupError of cleanupErrors) {
    process.stderr.write(
      `Suppressed after primary release-contract failure: ${
        cleanupError.stack ?? cleanupError
      }\n`
    );
  }
}

const releaseFailure = selectReleaseFailure(primaryError, cleanupErrors);
if (releaseFailure !== undefined) throw releaseFailure;

process.stdout.write(
  `Artifact release contract verified on Node ${
    process.versions.node
  }: clean consumers, topo order, exact tar dependency, fresh-store offline reinstall${
    publicationHead === undefined
      ? ''
      : `, and clean Git head ${publicationHead}`
  }\n`
);
