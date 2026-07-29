import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadLocalSourceBundle } from '../test-support/local-source-bundle.mjs';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixtureRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reya-source-bundle-'));
  const source = path.join(root, 'packages/tomls/src');
  await mkdir(path.join(source, 'omnibus'), { recursive: true });
  await mkdir(path.join(source, 'shared'), { recursive: true });
  await writeFile(
    path.join(source, 'omnibus/reya_network.toml'),
    'include = ["../shared/value.toml"]\nversion = "1.2.3"\n'
  );
  await writeFile(
    path.join(source, 'shared/value.toml'),
    '[var]\nvalue = "pinned"\n'
  );
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
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const commit = stdout.trim();
  const files = [
    {
      content:
        'include = ["../shared/value.toml"]\nversion = "1.2.3"\n',
      path: 'packages/tomls/src/omnibus/reya_network.toml',
      sha256: sha256(
        'include = ["../shared/value.toml"]\nversion = "1.2.3"\n'
      ),
    },
    {
      content: '[var]\nvalue = "pinned"\n',
      path: 'packages/tomls/src/shared/value.toml',
      sha256: sha256('[var]\nvalue = "pinned"\n'),
    },
  ];
  const canonical = {
    schemaVersion: 1,
    repository: 'Reya-Labs/reya-deployments',
    commit,
    root: 'packages/tomls/src/omnibus/reya_network.toml',
    files,
  };
  return {
    bundleSha256: sha256(JSON.stringify(canonical)),
    commit,
    root,
  };
}

async function cycleRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reya-source-cycle-'));
  const source = path.join(root, 'packages/tomls/src/omnibus');
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, 'reya_network.toml'),
    'include = ["reya_network.toml"]\n'
  );
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
      'cycle',
    ],
    { cwd: root }
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  return { commit: stdout.trim(), root };
}

test('local source loader reads only one exact Git object closure', async () => {
  const fixture = await fixtureRepository();
  const bundle = await loadLocalSourceBundle({
    commit: fixture.commit,
    expectedBundleSha256: fixture.bundleSha256,
    repositoryPath: fixture.root,
  });
  assert.equal(bundle.commit, fixture.commit);
  assert.equal(bundle.bundleSha256, fixture.bundleSha256);
  assert.deepEqual(
    bundle.files.map((file) => file.path),
    [
      'packages/tomls/src/omnibus/reya_network.toml',
      'packages/tomls/src/shared/value.toml',
    ]
  );
});

test('local source loader rejects a mismatched manifest digest', async () => {
  const fixture = await fixtureRepository();
  await assert.rejects(
    loadLocalSourceBundle({
      commit: fixture.commit,
      expectedBundleSha256: '0'.repeat(64),
      repositoryPath: fixture.root,
    }),
    /digest does not match/
  );
});

test('local source loader rejects include cycles before digesting', async () => {
  const fixture = await cycleRepository();
  await assert.rejects(
    loadLocalSourceBundle({
      commit: fixture.commit,
      expectedBundleSha256: '0'.repeat(64),
      repositoryPath: fixture.root,
    }),
    /cycle detected/
  );
});
