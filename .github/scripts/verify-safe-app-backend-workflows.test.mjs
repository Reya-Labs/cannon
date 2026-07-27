import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifySafeAppBackendWorkflows } from './verify-safe-app-backend-workflows.mjs';

const ciSource = readFileSync('.github/workflows/safe-app-backend.yml', 'utf8');
const publishSource = readFileSync(
  '.github/workflows/safe-app-backend-publish.yml',
  'utf8'
);

function verify(
  publishMutation = (source) => source,
  ciMutation = (source) => source
) {
  verifySafeAppBackendWorkflows({
    ciSource: ciMutation(ciSource),
    publishSource: publishMutation(publishSource),
  });
}

test('accepts the reviewed split workflow policy', () => {
  assert.doesNotThrow(() => verify());
});

test('rejects manual publication', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:')
    )
  );
});

test('rejects a fail-open activation variable', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace(
        "vars.CANNON_SAFE_PUBLISH_ENABLED == 'true'",
        "vars.CANNON_SAFE_PUBLISH_ENABLED != 'false'"
      )
    )
  );
});

test('rejects publication without the protected environment', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace('    environment: cannon-image-publish\n', '')
    )
  );
});

test('rejects a pull request publisher trigger', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace('on:\n  push:', 'on:\n  pull_request:\n  push:')
    )
  );
});

test('rejects write access in pull request CI', () => {
  assert.throws(() =>
    verify(
      (source) => source,
      (source) =>
        source.replace(
          'permissions:\n  contents: read',
          'permissions:\n  contents: write'
        )
    )
  );
});
