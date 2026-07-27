#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { verifySafeAppBackendWorkflows } from './verify-safe-app-backend-workflows.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), '../..');

const runtimeImagePaths = [
  '.github/dependabot.yml',
  '.github/scripts/generate-bundle-input-sbom.mjs',
  '.github/scripts/generate-bundle-input-sbom.test.mjs',
  '.github/scripts/scan-runtime-image.sh',
  '.github/scripts/verify-runtime-image.sh',
  '.github/workflows/runtime-image-security.yml',
  'docker/api.Dockerfile',
  'docker/indexer.Dockerfile',
  'docker/repo.Dockerfile',
  'package.json',
  'packages/api/**',
  'packages/builder/**',
  'packages/cli/**',
  'packages/indexer/**',
  'packages/repo/**',
  'packages/safe-app-backend/**',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

const workflowPolicies = new Map([
  [
    'artifact-repository.yml',
    {
      pull_request: null,
      push: ['dev', 'main'],
    },
  ],
  [
    'lint.yml',
    {
      pull_request: null,
      push: ['alpha', 'dev', 'main'],
    },
  ],
  [
    'safe-app-backend.yml',
    {
      pull_request: ['dev', 'main'],
      push: ['main'],
      workflow_call: null,
    },
  ],
  ['safe-app-backend-publish.yml', null],
  [
    'reya-safe-ui.yml',
    {
      pull_request: ['dev', 'main'],
      push: ['dev', 'main'],
      workflow_dispatch: null,
    },
  ],
  [
    'runtime-image-security.yml',
    {
      pull_request: {
        paths: runtimeImagePaths,
      },
      push: {
        branches: ['dev', 'main'],
        paths: runtimeImagePaths,
      },
      schedule: [{ cron: '23 6 * * 1' }],
      workflow_dispatch: {
        inputs: {
          runtime: {
            description: 'Image whose already-pushed digest should be scanned',
            required: false,
            default: 'repo',
            type: 'choice',
            options: ['repo', 'indexer', 'api', 'safe-app-backend'],
          },
          image_ref: {
            description:
              'Optional ghcr.io/reya-labs IMAGE@sha256 digest to scan instead of rebuilding',
            required: false,
            type: 'string',
          },
          expected_revision: {
            description:
              'Required 40-character Cannon source revision when image_ref is set',
            required: false,
            type: 'string',
          },
        },
      },
    },
  ],
  [
    'supply-chain.yml',
    {
      pull_request: null,
      push: ['dev', 'main'],
    },
  ],
  [
    'test.yml',
    {
      pull_request: null,
      push: ['alpha', 'dev', 'main'],
    },
  ],
  [
    'website-e2e.yml',
    {
      pull_request: null,
      push: ['dev'],
    },
  ],
]);

// The runtime workflow builds untrusted source and can pull release artifacts.
// Keep its complete reviewed source fail-closed: any legitimate edit must update
// this policy digest in the same review.
const exactWorkflowDigests = new Map([
  [
    'runtime-image-security.yml',
    '5452b3639233655691185f3ea7495c46f626145b7f205eceaba9e1fa632d42f7',
  ],
]);

const exactPolicyFileDigests = new Map([
  [
    '.github/scripts/generate-bundle-input-sbom.mjs',
    'ee941346cf3fc93d1acdd9a17310898ab23ef16f9a3da87065dad45ed386230e',
  ],
  [
    '.github/scripts/scan-runtime-image.sh',
    'ff5eee3cd4763b85ffca796a6a937d4273cfb6d1c9932168799a207d9f9009e4',
  ],
  [
    '.github/scripts/verify-runtime-image.sh',
    '149ed11e9ef1eca9152e9ecc7bab621b7813c565a4fb357b9487e9e31b9a5da6',
  ],
]);

// PRO-731 is based before the PRO-715 UI branch. Keep that branch independently
// testable, but make the workflow mandatory as soon as the UI package is in the
// composed tree. This turns a workflow deletion into a fail-closed policy error
// without duplicating PRO-715 files in this branch.
const transitionalWorkflowMarkers = new Map([
  ['reya-safe-ui.yml', 'packages/reya-safe-ui/package.json'],
]);

const retiredWorkflows = new Set([
  'backmerge.yml',
  'build-supersim.yml',
  'bump-viem.yml',
  'docker-build.yml',
  'release.yml',
  'test-e2e.yml',
  'upload-to-ipfs.yml',
]);

const allowedActionUses = new Set([
  'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
  'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25',
  'cypress-io/github-action@f790eee7a50d9505912f50c2095510be7de06aa7',
  'docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7',
  'foundry-rs/foundry-toolchain@b00af27efadbc7b4ca8b82abbd903b17cc874d2a',
  'pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271',
  'pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1',
]);

const allowedContainerImages = new Set([
  'redis:7.4.2-alpine@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952',
]);

const allowedRunners = new Set(['ubuntu-24.04', 'ubuntu-24.04-arm']);

const allowedGitHubContexts = new Map([
  [
    '.github/workflows/runtime-image-security.yml',
    new Set([
      'github.actor',
      'github.event.pull_request.head.sha',
      'github.ref_protected',
      'github.repository',
      'github.sha',
      'github.token',
    ]),
  ],
  [
    '.github/workflows/reya-safe-ui.yml',
    new Set([
      'github.event.pull_request.number',
      'github.event_name',
      'github.run_id',
      'github.sha',
    ]),
  ],
  [
    '.github/workflows/safe-app-backend.yml',
    new Set([
      'github.event.pull_request.number',
      'github.event_name',
      'github.run_id',
      'github.sha',
    ]),
  ],
]);

const defaultAllowedGitHubContexts = new Set([
  'github.event_name',
  'github.ref',
  'github.workflow',
]);

const forbiddenText = new Map([
  ['pull_request_target', 'privileged pull-request trigger'],
  ['repo.usecannon.com', 'hosted Cannon artifact endpoint'],
  ['api.usecannon.com', 'hosted Cannon API endpoint'],
  ['safe-staging.usecannon.com', 'hosted Cannon staging endpoint'],
  ['REPO_CANNON_JWT', 'hosted Cannon writer credential'],
  ['NPM_TOKEN', 'upstream npm publication credential'],
  ['WORKFLOW_TOKEN', 'legacy write-capable workflow token'],
  ['changesets/action', 'upstream package release action'],
  ['persist-credentials: true', 'persisted checkout credentials'],
]);

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sameStrings = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return [...left].sort().join('\n') === [...right].sort().join('\n');
};

const readYaml = (path, displayPath, errors) => {
  const text = readFileSync(path, 'utf8');
  const document = parseDocument(text, {
    prettyErrors: true,
    uniqueKeys: true,
  });

  if (document.errors.length > 0) {
    for (const error of document.errors) {
      errors.push(`${displayPath}: invalid YAML (${error.message})`);
    }
    return { text, value: undefined };
  }

  try {
    return {
      text,
      value: document.toJS({ maxAliasCount: 0 }),
    };
  } catch (error) {
    errors.push(`${displayPath}: unsafe YAML (${error.message})`);
    return { text, value: undefined };
  }
};

const auditRawText = (text, displayPath, errors) => {
  for (const [needle, description] of forbiddenText) {
    if (text.includes(needle)) {
      errors.push(
        `${displayPath}: contains forbidden ${description} (${needle})`
      );
    }
  }
};

const auditEvents = (value, expected, displayPath, errors) => {
  if (!isRecord(value)) {
    errors.push(`${displayPath}: on must be an explicit event mapping`);
    return;
  }

  const actualEvents = Object.keys(value);
  const expectedEvents = Object.keys(expected);
  if (!sameStrings(actualEvents, expectedEvents)) {
    errors.push(
      `${displayPath}: events must be exactly ${expectedEvents
        .sort()
        .join(', ')}`
    );
  }

  for (const [event, expectedConfiguration] of Object.entries(expected)) {
    const configuration = value[event];
    if (expectedConfiguration === null) {
      if (configuration !== null) {
        errors.push(
          `${displayPath}: ${event} must run for every pull-request base`
        );
      }
      continue;
    }

    if (
      !Array.isArray(expectedConfiguration) ||
      !expectedConfiguration.every((item) => typeof item === 'string')
    ) {
      if (!isDeepStrictEqual(configuration, expectedConfiguration)) {
        errors.push(
          `${displayPath}: ${event} must exactly match the reviewed configuration`
        );
      }
      continue;
    }

    if (!isRecord(configuration)) {
      errors.push(
        `${displayPath}: ${event} must have an explicit branches mapping`
      );
      continue;
    }

    if (!sameStrings(Object.keys(configuration), ['branches'])) {
      errors.push(`${displayPath}: ${event} may configure only branches`);
    }

    if (!sameStrings(configuration.branches, expectedConfiguration)) {
      errors.push(
        `${displayPath}: ${event} branches must be exactly ${[
          ...expectedConfiguration,
        ]
          .sort()
          .join(', ')}`
      );
    }
  }
};

const auditPermissions = (value, displayPath, errors) => {
  if (
    !isRecord(value) ||
    !sameStrings(Object.keys(value), ['contents']) ||
    value.contents !== 'read'
  ) {
    errors.push(
      `${displayPath}: workflow permissions must be exactly contents: read`
    );
  }
};

const resolveLocalAction = (repositoryRoot, use, displayPath, errors) => {
  const actionDirectory = resolve(repositoryRoot, use.slice(2));
  const relativePath = relative(repositoryRoot, actionDirectory);
  if (
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    !relativePath.startsWith(`.github${sep}actions${sep}`)
  ) {
    errors.push(
      `${displayPath}: local actions must resolve beneath .github/actions (${use})`
    );
    return undefined;
  }

  const candidates = ['action.yml', 'action.yaml']
    .map((name) => join(actionDirectory, name))
    .filter(existsSync);
  if (candidates.length !== 1) {
    errors.push(
      `${displayPath}: local action ${use} must contain exactly one action.yml or action.yaml`
    );
    return undefined;
  }

  return candidates[0];
};

const auditActionUse = (
  use,
  step,
  repositoryRoot,
  displayPath,
  errors,
  visitedActions
) => {
  if (typeof use !== 'string') {
    errors.push(`${displayPath}: uses must be a literal string`);
    return;
  }

  if (use.startsWith('./')) {
    const actionPath = resolveLocalAction(
      repositoryRoot,
      use,
      displayPath,
      errors
    );
    if (actionPath && !visitedActions.has(actionPath)) {
      visitedActions.add(actionPath);
      const actionDisplayPath = relative(repositoryRoot, actionPath);
      const { text, value } = readYaml(actionPath, actionDisplayPath, errors);
      auditRawText(text, actionDisplayPath, errors);
      if (value !== undefined) {
        auditNode(
          value,
          repositoryRoot,
          actionDisplayPath,
          errors,
          visitedActions
        );
      }
    }
    return;
  }

  if (use.startsWith('docker://')) {
    errors.push(
      `${displayPath}: container actions are not in the allowlist (${use})`
    );
    return;
  }

  const separator = use.lastIndexOf('@');
  const revision = separator === -1 ? '' : use.slice(separator + 1);
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    errors.push(
      `${displayPath}: action is not pinned to a full commit SHA (${use})`
    );
  }
  if (!allowedActionUses.has(use)) {
    errors.push(
      `${displayPath}: action is not in the reviewed allowlist (${use})`
    );
  }

  if (use.startsWith('actions/checkout@')) {
    const persistCredentials = step?.with?.['persist-credentials'];
    if (persistCredentials !== false && persistCredentials !== 'false') {
      errors.push(
        `${displayPath}: checkout must set persist-credentials: false`
      );
    }
  }
};

const auditContainerImage = (image, displayPath, errors) => {
  if (typeof image !== 'string') {
    errors.push(`${displayPath}: container image must be a literal string`);
    return;
  }
  if (!/@sha256:[0-9a-f]{64}$/u.test(image)) {
    errors.push(
      `${displayPath}: container image is not digest-pinned (${image})`
    );
  }
  if (!allowedContainerImages.has(image)) {
    errors.push(
      `${displayPath}: container image is not in the reviewed allowlist (${image})`
    );
  }
};

const auditNode = (
  value,
  repositoryRoot,
  displayPath,
  errors,
  visitedActions,
  path = []
) => {
  if (typeof value === 'string') {
    if (/\bsecrets\s*(?:\.|\[|\b)/iu.test(value)) {
      errors.push(
        `${displayPath}: repository secret reference is forbidden at ${path.join(
          '.'
        )}`
      );
    }
    const containsExpression = value.includes('${{') || path.at(-1) === 'if';
    const allowedContexts = new Set([
      ...defaultAllowedGitHubContexts,
      ...(allowedGitHubContexts.get(displayPath) ?? []),
    ]);
    const githubContextReferences = [
      ...value.matchAll(/\bgithub(?:\s*\.\s*[A-Za-z0-9_]+)+/giu),
    ].map((match) => match[0].replace(/\s+/g, ''));
    const hasComputedOrWholeGitHubContext =
      /\bgithub\s*\[/iu.test(value) || /\bgithub\b(?!\s*[\[.])/iu.test(value);
    const hasUnreviewedGitHubContext =
      containsExpression &&
      (hasComputedOrWholeGitHubContext ||
        githubContextReferences.some(
          (reference) => !allowedContexts.has(reference)
        ));
    if (hasUnreviewedGitHubContext) {
      errors.push(
        `${displayPath}: unreviewed GitHub context reference is forbidden at ${path.join(
          '.'
        )}; only github.event_name, github.workflow, and github.ref are allowed`
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      auditNode(item, repositoryRoot, displayPath, errors, visitedActions, [
        ...path,
        String(index),
      ])
    );
    return;
  }

  if (!isRecord(value)) return;

  if ('uses' in value) {
    auditActionUse(
      value.uses,
      value,
      repositoryRoot,
      `${displayPath}:${[...path, 'uses'].join('.')}`,
      errors,
      visitedActions
    );
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (key === 'secrets') {
      errors.push(
        `${displayPath}: secrets configuration is forbidden at ${childPath.join(
          '.'
        )}`
      );
    }
    if (key === 'image') {
      auditContainerImage(
        child,
        `${displayPath}:${childPath.join('.')}`,
        errors
      );
    }
    if (key === 'continue-on-error' && child !== false && child !== 'false') {
      errors.push(
        `${displayPath}: continue-on-error is forbidden at ${childPath.join(
          '.'
        )}`
      );
    }
    if (key !== 'uses') {
      auditNode(
        child,
        repositoryRoot,
        displayPath,
        errors,
        visitedActions,
        childPath
      );
    }
  }
};

const auditWorkflow = (
  expectedEvents,
  repositoryRoot,
  workflowPath,
  errors,
  visitedActions
) => {
  const displayPath = relative(repositoryRoot, workflowPath);
  const { text, value } = readYaml(workflowPath, displayPath, errors);
  auditRawText(text, displayPath, errors);
  const expectedDigest = exactWorkflowDigests.get(
    workflowPath.split(sep).at(-1)
  );
  if (expectedDigest !== undefined) {
    const actualDigest = createHash('sha256').update(text).digest('hex');
    if (actualDigest !== expectedDigest) {
      errors.push(
        `${displayPath}: source must exactly match the reviewed workflow digest`
      );
    }
  }
  if (!isRecord(value)) {
    if (value !== undefined)
      errors.push(`${displayPath}: workflow must be a mapping`);
    return;
  }

  auditEvents(value.on, expectedEvents, displayPath, errors);
  auditPermissions(value.permissions, displayPath, errors);

  if (!isRecord(value.jobs) || Object.keys(value.jobs).length === 0) {
    errors.push(`${displayPath}: jobs must be a non-empty mapping`);
  } else {
    for (const [jobName, job] of Object.entries(value.jobs)) {
      if (!isRecord(job)) {
        errors.push(`${displayPath}: job ${jobName} must be a mapping`);
        continue;
      }
      const expectedJobPermissions =
        displayPath === '.github/workflows/runtime-image-security.yml' &&
        jobName === 'scan-pushed-digest'
          ? {
              attestations: 'read',
              contents: 'read',
              packages: 'read',
            }
          : undefined;
      if (
        expectedJobPermissions !== undefined &&
        !isDeepStrictEqual(job.permissions, expectedJobPermissions)
      ) {
        errors.push(
          `${displayPath}: job ${jobName} permissions must be exactly attestations: read, contents: read, and packages: read`
        );
      } else if (expectedJobPermissions === undefined && 'permissions' in job) {
        errors.push(
          `${displayPath}: job ${jobName} must inherit read-only workflow permissions`
        );
      }
      if (!('timeout-minutes' in job)) {
        errors.push(`${displayPath}: job ${jobName} must set timeout-minutes`);
      }
      if ('runs-on' in job && !allowedRunners.has(job['runs-on'])) {
        errors.push(`${displayPath}: job ${jobName} uses an unreviewed runner`);
      }
    }
  }

  auditNode(value, repositoryRoot, displayPath, errors, visitedActions);
};

const auditSafeAppBackendPublisher = (repositoryRoot, workflowPath, errors) => {
  const displayPath = relative(repositoryRoot, workflowPath);
  const { text, value } = readYaml(workflowPath, displayPath, errors);
  auditRawText(text, displayPath, errors);
  if (!isRecord(value)) {
    if (value !== undefined)
      errors.push(`${displayPath}: workflow must be a mapping`);
    return;
  }

  auditEvents(value.on, { push: ['dev'] }, displayPath, errors);
  auditPermissions(value.permissions, displayPath, errors);

  if (
    !isRecord(value.jobs) ||
    !sameStrings(Object.keys(value.jobs), [
      'publish-safe-app-backend',
      'safe-app-backend',
    ])
  ) {
    errors.push(
      `${displayPath}: jobs must be exactly safe-app-backend and publish-safe-app-backend`
    );
  } else {
    const reusableJob = value.jobs['safe-app-backend'];
    if (
      !isRecord(reusableJob) ||
      !sameStrings(Object.keys(reusableJob), ['permissions', 'uses']) ||
      reusableJob.uses !== './.github/workflows/safe-app-backend.yml' ||
      !isRecord(reusableJob.permissions) ||
      !sameStrings(Object.keys(reusableJob.permissions), ['contents']) ||
      reusableJob.permissions.contents !== 'read'
    ) {
      errors.push(
        `${displayPath}: safe-app-backend must be an exact read-only call to the reviewed reusable workflow`
      );
    }

    const publisherJob = value.jobs['publish-safe-app-backend'];
    const expectedPermissions = {
      'artifact-metadata': 'write',
      attestations: 'write',
      contents: 'read',
      'id-token': 'write',
      packages: 'write',
    };
    if (
      !isRecord(publisherJob) ||
      !isRecord(publisherJob.permissions) ||
      !sameStrings(
        Object.keys(publisherJob.permissions),
        Object.keys(expectedPermissions)
      ) ||
      Object.entries(expectedPermissions).some(
        ([key, expected]) => publisherJob.permissions[key] !== expected
      )
    ) {
      errors.push(
        `${displayPath}: publisher job permissions must match the reviewed GHCR and attestation set`
      );
    }
    if (
      !isRecord(publisherJob) ||
      publisherJob['runs-on'] !== 'ubuntu-24.04' ||
      publisherJob['timeout-minutes'] !== 30
    ) {
      errors.push(
        `${displayPath}: publisher runner and timeout must remain ubuntu-24.04 and 30 minutes`
      );
    }
  }

  try {
    verifySafeAppBackendWorkflows({
      ciSource: readFileSync(
        join(repositoryRoot, '.github/workflows/safe-app-backend.yml'),
        'utf8'
      ),
      publishSource: text,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'publisher policy failed';
    errors.push(`${displayPath}: ${message}`);
  }
};

export const auditRepository = (repositoryRoot = defaultRepositoryRoot) => {
  const root = resolve(repositoryRoot);
  const workflowPath = join(root, '.github/workflows');
  const errors = [];
  const visitedActions = new Set();
  const workflows = readdirSync(workflowPath)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();

  for (const retired of retiredWorkflows) {
    if (workflows.includes(retired)) {
      errors.push(`${retired}: retired mutation workflow must not be present`);
    }
  }

  for (const workflow of workflows) {
    if (!workflowPolicies.has(workflow)) {
      errors.push(`${workflow}: workflow is not in the reviewed allowlist`);
      continue;
    }
    if (workflow === 'safe-app-backend-publish.yml') {
      auditSafeAppBackendPublisher(root, join(workflowPath, workflow), errors);
    } else {
      auditWorkflow(
        workflowPolicies.get(workflow),
        root,
        join(workflowPath, workflow),
        errors,
        visitedActions
      );
    }
  }

  for (const expectedWorkflow of workflowPolicies.keys()) {
    const marker = transitionalWorkflowMarkers.get(expectedWorkflow);
    const isRequired = marker === undefined || existsSync(join(root, marker));
    if (isRequired && !workflows.includes(expectedWorkflow)) {
      errors.push(`${expectedWorkflow}: required workflow is missing`);
    }
  }

  for (const [path, expectedDigest] of exactPolicyFileDigests) {
    const policyPath = join(root, path);
    if (!existsSync(policyPath)) {
      errors.push(`${path}: required policy file is missing`);
      continue;
    }
    const actualDigest = createHash('sha256')
      .update(readFileSync(policyPath, 'utf8'))
      .digest('hex');
    if (actualDigest !== expectedDigest) {
      errors.push(
        `${path}: source must exactly match the reviewed policy digest`
      );
    }
  }

  return errors.sort();
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const errors = auditRepository();
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ERROR ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      'Audited repository workflows: triggers, permissions, actions, images, and secrets match the reviewed policy.'
    );
  }
}
