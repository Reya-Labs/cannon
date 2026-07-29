import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  localPreviewFailureCode,
  parseLocalPreviewArguments,
} from '../scripts/run-local-preview.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const DEFAULT_MANIFEST = path.join(
  PACKAGE_ROOT,
  'test-support/fixtures/reya-network-2b10669075b91eb8db781d199292f30c52f8e994/resolution.json'
);

test('local preview CLI accepts only explicit absolute local inputs', () => {
  assert.deepEqual(
    parseLocalPreviewArguments([
      '--artifact-cache',
      '/tmp/reya-artifacts',
      '--source-repository',
      '/tmp/reya-deployments',
      '--output',
      '/tmp/preview.json',
    ]),
    {
      artifactCache: path.normalize('/tmp/reya-artifacts'),
      forkBlockHash: undefined,
      forkBlockNumber: undefined,
      manifest: DEFAULT_MANIFEST,
      output: path.normalize('/tmp/preview.json'),
      sourceRepository: path.normalize('/tmp/reya-deployments'),
    }
  );
  assert.deepEqual(
    parseLocalPreviewArguments([
      '--artifact-cache',
      '/tmp/reya-artifacts',
      '--source-repository',
      '/tmp/reya-deployments',
      '--fork-block-number',
      '42',
      '--fork-block-hash',
      `0x${'a'.repeat(64)}`,
    ]),
    {
      artifactCache: path.normalize('/tmp/reya-artifacts'),
      forkBlockHash: `0x${'a'.repeat(64)}`,
      forkBlockNumber: '42',
      manifest: DEFAULT_MANIFEST,
      output: undefined,
      sourceRepository: path.normalize('/tmp/reya-deployments'),
    }
  );
});

test('local preview CLI rejects unknown, duplicate, relative, and missing paths', () => {
  for (const argv of [
    [],
    ['--artifact-cache', '/tmp/reya-artifacts'],
    ['--artifact-cache', 'relative', '--source-repository', '/tmp/source'],
    ['--rpc-url', 'https://example.invalid'],
    [
      '--artifact-cache',
      '/tmp/one',
      '--artifact-cache',
      '/tmp/two',
      '--source-repository',
      '/tmp/source',
    ],
    [
      '--artifact-cache',
      '/tmp/one',
      '--source-repository',
      '/tmp/source',
      '--fork-block-number',
      '42',
    ],
    [
      '--artifact-cache',
      '/tmp/one',
      '--source-repository',
      '/tmp/source',
      '--fork-block-number',
      '042',
      '--fork-block-hash',
      `0x${'a'.repeat(64)}`,
    ],
  ]) {
    assert.throws(
      () => parseLocalPreviewArguments(argv),
      /(?:local preview|absolute path)/
    );
  }
});

test('local preview CLI reports only bounded failure codes', () => {
  assert.equal(
    localPreviewFailureCode(
      new Error('outer', {
        cause: new Error('local fork upstream cannot serve finalized state', {
          cause: new Error(
            'provider URL https://example.invalid/private-token failed'
          ),
        }),
      })
    ),
    'RPC_PINNED_STATE_UNAVAILABLE'
  );
  assert.equal(
    localPreviewFailureCode(
      new Error('preview build failed at invoke.upgrade')
    ),
    'CANNON_BUILD_FAILED'
  );
  assert.equal(
    localPreviewFailureCode(
      new Error('local QA provenance rejected: Cannon worktree is dirty')
    ),
    'CANNON_PROVENANCE_FAILED'
  );
  assert.equal(
    localPreviewFailureCode(new Error('unknown secret-bearing failure')),
    'LOCAL_PREVIEW_FAILED'
  );

  const cycle = new Error('outer');
  cycle.cause = cycle;
  assert.equal(localPreviewFailureCode(cycle), 'LOCAL_PREVIEW_FAILED');
});
