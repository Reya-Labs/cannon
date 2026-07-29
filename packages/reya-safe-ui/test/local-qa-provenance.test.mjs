import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  loadLocalQaProvenance,
  validateLocalQaRuntimeVersions,
} from '../test-support/local-qa-provenance.mjs';

const execFileAsync = promisify(execFile);
const HEAD = '1'.repeat(40);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureRepository(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reya-qa-provenance-'));
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, 'packages/reya-safe-ui'), { recursive: true });
  await mkdir(path.join(root, 'packages/builder'), { recursive: true });
  await mkdir(path.join(root, 'packages/artifact-codec'), { recursive: true });
  await mkdir(path.join(root, 'packages/builder/dist/src'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'packages/artifact-codec/dist'), {
    recursive: true,
  });
  const files = new Map([
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
    [
      'packages/reya-safe-ui/package.json',
      '{"name":"@reya/cannon-safe-ui","version":"0.0.0"}\n',
    ],
    [
      'packages/builder/package.json',
      '{"name":"@usecannon/builder","version":"2.26.1"}\n',
    ],
    [
      'packages/artifact-codec/package.json',
      '{"name":"@usecannon/artifact-codec","version":"0.1.0-beta.2"}\n',
    ],
    ['packages/builder/dist/src/index.js', 'export const builder = true;\n'],
    ['packages/artifact-codec/dist/index.js', 'export const codec = true;\n'],
  ]);
  for (const [relativePath, content] of files) {
    await writeFile(path.join(root, relativePath), content);
  }
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Reya QA',
      '-c',
      'user.email=qa@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root }
  );
  return { files, root };
}

test('derives a strict frozen clean provenance object from one Git checkout', async (context) => {
  const fixture = await fixtureRepository(context);
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  const result = await loadLocalQaProvenance({
    repositoryRoot: fixture.root,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result), [
    'schemaVersion',
    'cannonCommit',
    'worktreeDirty',
    'nodeVersion',
    'pnpmVersion',
    'pnpmLockSha256',
    'reyaSafeUiPackageJsonSha256',
    'builderVersion',
    'artifactCodecVersion',
    'builderDistSha256',
    'artifactCodecDistSha256',
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.cannonCommit, stdout.trim());
  assert.equal(result.worktreeDirty, false);
  assert.equal(result.nodeVersion, '22.23.1');
  assert.equal(result.pnpmVersion, '10.11.0');
  assert.equal(
    result.pnpmLockSha256,
    sha256(fixture.files.get('pnpm-lock.yaml'))
  );
  assert.equal(
    result.reyaSafeUiPackageJsonSha256,
    sha256(fixture.files.get('packages/reya-safe-ui/package.json'))
  );
  assert.equal(result.builderVersion, '2.26.1');
  assert.equal(result.artifactCodecVersion, '0.1.0-beta.2');
  assert.match(result.builderDistSha256, /^[0-9a-f]{64}$/);
  assert.match(result.artifactCodecDistSha256, /^[0-9a-f]{64}$/);
});

test('rejects tracked, staged, and untracked whole-worktree changes', async (context) => {
  const tracked = await fixtureRepository(context);
  await writeFile(path.join(tracked.root, 'pnpm-lock.yaml'), 'changed\n');
  await assert.rejects(
    loadLocalQaProvenance({
        repositoryRoot: tracked.root,
      }),
    /worktree is dirty/
  );

  const staged = await fixtureRepository(context);
  await writeFile(
    path.join(staged.root, 'packages/builder/package.json'),
    '{"name":"@usecannon/builder","version":"2.26.2"}\n'
  );
  await execFileAsync('git', ['add', 'packages/builder/package.json'], {
    cwd: staged.root,
  });
  await assert.rejects(
    loadLocalQaProvenance({
        repositoryRoot: staged.root,
      }),
    /worktree is dirty/
  );

  const untracked = await fixtureRepository(context);
  await writeFile(path.join(untracked.root, 'untracked.txt'), 'not committed\n');
  await assert.rejects(
    loadLocalQaProvenance({
        repositoryRoot: untracked.root,
      }),
    /worktree is dirty/
  );
});

test('binds the exact rebuilt Cannon runtime output bytes', async (context) => {
  const first = await fixtureRepository(context);
  const firstResult = await loadLocalQaProvenance({
    repositoryRoot: first.root,
  });

  const second = await fixtureRepository(context);
  await writeFile(
    path.join(second.root, 'packages/builder/dist/src/index.js'),
    'export const builder = false;\n'
  );
  await execFileAsync('git', ['add', 'packages/builder/dist/src/index.js'], {
    cwd: second.root,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Reya QA',
      '-c',
      'user.email=qa@example.invalid',
      'commit',
      '-qm',
      'change runtime output',
    ],
    { cwd: second.root }
  );
  const secondResult = await loadLocalQaProvenance({
    repositoryRoot: second.root,
  });

  assert.notEqual(
    firstResult.builderDistSha256,
    secondResult.builderDistSha256
  );
  assert.equal(
    firstResult.artifactCodecDistSha256,
    secondResult.artifactCodecDistSha256
  );
});

test('uses only fixed bounded Git invocations', async (context) => {
  const fixture = await fixtureRepository(context);
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ args: [...args], command, options });
    if (args[0] === 'rev-parse') callback(null, `${HEAD}\n`, '');
    else callback(null, '', '');
  };
  const result = await loadLocalQaProvenance({
    execFileImpl,
    repositoryRoot: fixture.root,
  });

  assert.equal(result.cannonCommit, HEAD);
  assert.equal(result.worktreeDirty, false);
  assert.deepEqual(
    calls.map(({ args, command }) => ({ args, command })),
    [
      {
        command: 'git',
        args: ['rev-parse', '--verify', 'HEAD'],
      },
      {
        command: 'git',
        args: [
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
          '-z',
        ],
      },
    ]
  );
  assert.equal(calls[0].options.maxBuffer, 128);
  assert.equal(calls[1].options.maxBuffer, 1024 * 1024);
  assert.equal(calls[0].options.timeout, 30_000);
  assert.equal(calls[1].options.timeout, 30_000);
  assert.deepEqual(Object.keys(calls[0].options.env).sort(), [
    'GIT_CEILING_DIRECTORIES',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_OPTIONAL_LOCKS',
    'GIT_TERMINAL_PROMPT',
    'LANG',
    'LC_ALL',
    'PATH',
  ]);
});

test('rejects malformed or oversized Git output with a fixed error', async (context) => {
  const fixture = await fixtureRepository(context);
  for (const outputs of [
    { head: `${'A'.repeat(40)}\n`, status: '' },
    { head: `${HEAD}\nextra`, status: '' },
    { head: `${HEAD}\n`, status: 'x'.repeat(1024 * 1024 + 1) },
  ]) {
    const execFileImpl = (_command, args, _options, callback) => {
      callback(
        null,
        args[0] === 'rev-parse' ? outputs.head : outputs.status,
        ''
      );
    };
    await assert.rejects(
      loadLocalQaProvenance({
        execFileImpl,
        repositoryRoot: fixture.root,
      }),
      {
        message: /local QA provenance rejected: (?:Git HEAD is invalid|Git inspection failed)/,
      }
    );
  }
});

test('rejects malformed package metadata without exposing file contents', async (context) => {
  const fixture = await fixtureRepository(context);
  const packagePath = path.join(
    fixture.root,
    'packages/artifact-codec/package.json'
  );
  await writeFile(packagePath, '{"name":"wrong","version":"SECRET"}\n');
  await execFileAsync('git', ['add', 'packages/artifact-codec/package.json'], {
    cwd: fixture.root,
  });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Reya QA',
      '-c',
      'user.email=qa@example.invalid',
      'commit',
      '-qm',
      'malformed package',
    ],
    { cwd: fixture.root }
  );
  await assert.rejects(
    loadLocalQaProvenance({
      repositoryRoot: fixture.root,
    }),
    (error) => {
      assert.equal(error.message.includes('SECRET'), false);
      assert.match(error.message, /package metadata is invalid/);
      return true;
    }
  );
});

test('accepts only the pinned Node and pnpm runtime versions', () => {
  assert.doesNotThrow(() =>
    validateLocalQaRuntimeVersions({
      nodeVersion: '22.23.1',
      pnpmVersion: '10.11.0',
    })
  );
  for (const value of [
    { nodeVersion: '22.23.0', pnpmVersion: '10.11.0' },
    { nodeVersion: '22.23.1', pnpmVersion: '10.12.0' },
  ]) {
    assert.throws(
      () => validateLocalQaRuntimeVersions(value),
      /runtime version is invalid/
    );
  }
});
