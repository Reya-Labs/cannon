#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const workflow = parse(
  readFileSync(
    join(repositoryRoot, '.github/workflows/runtime-publish.yml'),
    'utf8'
  )
);
const publicationStep = workflow.jobs['publish-runtime'].steps.find(
  (step) => step.name === 'Create immutable publication record'
);

assert.equal(typeof publicationStep?.run, 'string');

const baseEnvironment = {
  PATH: process.env.PATH,
  CREATED: '2026-07-28T16:00:00Z',
  GITHUB_REPOSITORY: 'Reya-Labs/cannon',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_RUN_ID: '30375902539',
  GITHUB_SERVER_URL: 'https://github.com',
  IMAGE_DIGEST:
    'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  IMAGE_NAME: 'ghcr.io/reya-labs/repo',
  RUNTIME_KIND: 'repo',
  SOURCE_REVISION: '23088b8d280801160ca635cac267f6edc2e43dae',
  VERSION: '2.21.1',
};

const runPublicationStep = (overrides = {}, prepare = () => {}) => {
  const runnerTemporary = mkdtempSync(
    join(tmpdir(), 'cannon-runtime-publication-test-')
  );
  const outputPath = join(runnerTemporary, 'github-output');
  const environment = {
    ...baseEnvironment,
    ...overrides,
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: runnerTemporary,
  };
  prepare({ environment, runnerTemporary });
  const result = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail'],
    {
      encoding: 'utf8',
      env: environment,
      input: publicationStep.run,
    }
  );
  return {
    outputPath,
    publicationPath: join(
      runnerTemporary,
      `cannon-runtime-publication-${environment.RUNTIME_KIND}`,
      'publication.json'
    ),
    result,
    runnerTemporary,
  };
};

const valid = runPublicationStep();
try {
  assert.equal(valid.result.status, 0, valid.result.stderr);
  const record = JSON.parse(readFileSync(valid.publicationPath, 'utf8'));
  assert.deepEqual(record, {
    created: baseEnvironment.CREATED,
    imageDigest: baseEnvironment.IMAGE_DIGEST,
    imageRef: `${baseEnvironment.IMAGE_NAME}@${baseEnvironment.IMAGE_DIGEST}`,
    platform: 'linux/amd64',
    publisher: {
      repository: 'Reya-Labs/cannon',
      runAttempt: 2,
      runId: 30375902539,
      runUrl: 'https://github.com/Reya-Labs/cannon/actions/runs/30375902539',
      workflow: 'Reya-Labs/cannon/.github/workflows/runtime-publish.yml',
      workflowRevision: baseEnvironment.SOURCE_REVISION,
    },
    runtime: 'repo',
    schemaVersion: 1,
    sourceRevision: baseEnvironment.SOURCE_REVISION,
    version: '2.21.1',
  });
  const output = readFileSync(valid.outputPath, 'utf8');
  assert.match(output, /^record_directory=.+$/mu);
  assert.match(output, /^record_path=.+\/publication\.json$/mu);
} finally {
  rmSync(valid.runnerTemporary, { force: true, recursive: true });
}

const rejectedCases = [
  ['malformed digest', { IMAGE_DIGEST: 'sha256:not-a-digest' }],
  ['unknown runtime', { RUNTIME_KIND: '../../repo' }],
  ['wrong image authority', { IMAGE_NAME: 'ghcr.io/attacker/repo' }],
  ['malformed revision', { SOURCE_REVISION: 'not-a-revision' }],
  ['malformed creation time', { CREATED: 'not-a-time' }],
  ['zero run ID', { GITHUB_RUN_ID: '0' }],
  ['zero run attempt', { GITHUB_RUN_ATTEMPT: '0' }],
  ['wrong repository', { GITHUB_REPOSITORY: 'attacker/cannon' }],
  ['empty version', { VERSION: '' }],
];

for (const [name, overrides] of rejectedCases) {
  const rejected = runPublicationStep(overrides);
  try {
    assert.notEqual(rejected.result.status, 0, `${name} was accepted`);
    assert.equal(
      existsSync(rejected.publicationPath),
      false,
      `${name} persisted a publication record`
    );
  } finally {
    rmSync(rejected.runnerTemporary, { force: true, recursive: true });
  }
}

const existingDirectory = runPublicationStep({}, ({ environment }) => {
  const directory = join(
    environment.RUNNER_TEMP,
    `cannon-runtime-publication-${environment.RUNTIME_KIND}`
  );
  rmSync(directory, { force: true, recursive: true });
  spawnSync('install', ['-d', '-m', '0700', directory], {
    env: { PATH: process.env.PATH },
  });
});
try {
  assert.notEqual(
    existingDirectory.result.status,
    0,
    'an existing publication directory was reused'
  );
  assert.equal(existsSync(existingDirectory.publicationPath), false);
} finally {
  rmSync(existingDirectory.runnerTemporary, {
    force: true,
    recursive: true,
  });
}

console.log('Runtime publication record fail-closed tests passed.');
