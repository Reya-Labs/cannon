import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const LOGIN = 'docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7';
const BUILDX =
  'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c';
const BUILD_PUSH =
  'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a';
const ATTEST = 'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6';

const BASE_DIGEST =
  'sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';
const BASE_NAME = 'docker.io/library/alpine:3.24.1';
const SOURCE_URL = 'https://github.com/Reya-Labs/cannon';

/**
 * The three Reya Cannon service images are packaged identically in reya-devops
 * and are published by identically shaped workflows. Describing them from one
 * reviewed shape is the point: a publisher cannot quietly drift from its peers,
 * and reviewing the shape once reviews all three.
 *
 * Only the names below vary. Every permission, trigger, action pin, base-image
 * digest and step is shared and fixed.
 */
export const SERVICE_PUBLISHERS = Object.freeze([
  Object.freeze({
    service: 'source-gateway',
    workflowName: 'Publish Source gateway image',
    imageName: 'ghcr.io/reya-labs/source-gateway',
    publishVariable: 'CANNON_SOURCE_GATEWAY_PUBLISH_ENABLED',
    summaryHeading: 'Source gateway image',
  }),
  Object.freeze({
    service: 'rpc-gateway',
    workflowName: 'Publish RPC gateway image',
    imageName: 'ghcr.io/reya-labs/rpc-gateway',
    publishVariable: 'CANNON_RPC_GATEWAY_PUBLISH_ENABLED',
    summaryHeading: 'RPC gateway image',
  }),
  Object.freeze({
    service: 'preview-worker',
    workflowName: 'Publish Preview worker image',
    imageName: 'ghcr.io/reya-labs/preview-worker',
    publishVariable: 'CANNON_PREVIEW_WORKER_PUBLISH_ENABLED',
    summaryHeading: 'Preview worker image',
  }),
]);

export const ciPathFor = (service) => `.github/workflows/${service}.yml`;
export const publishPathFor = (service) =>
  `.github/workflows/${service}-publish.yml`;

// The publisher builds from a protected dev head only, so the CI workflow it
// calls must be reachable as a trusted reusable call and must not itself run on
// a dev push. Otherwise the same commit would be validated twice, and the
// second path would not be the one the publisher gates on.
const EXPECTED_CI_TRIGGERS = {
  pull_request: {
    branches: ['dev', 'main'],
  },
  push: {
    branches: ['main'],
  },
  workflow_call: null,
};

/**
 * An exact, parsed policy contract. The publisher runs with package, OIDC and
 * attestation write authority, so an extra field, step, command or action input
 * would silently expand that authority. Everything is compared, not sampled.
 *
 * @param {(typeof SERVICE_PUBLISHERS)[number]} descriptor
 */
export function expectedPublishWorkflow(descriptor) {
  const { service, workflowName, imageName, publishVariable, summaryHeading } =
    descriptor;
  const scripts = `packages/${service}/scripts`;
  return {
    name: workflowName,
    on: {
      push: {
        branches: ['dev'],
      },
    },
    permissions: {
      contents: 'read',
    },
    jobs: {
      [service]: {
        permissions: {
          contents: 'read',
        },
        uses: `./.github/workflows/${service}.yml`,
      },
      [`publish-${service}`]: {
        needs: service,
        if:
          `needs.${service}.result == 'success' && ` +
          `vars.${publishVariable} == 'true' && ` +
          "github.repository == 'Reya-Labs/cannon' && " +
          "github.event_name == 'push' && " +
          "github.ref == 'refs/heads/dev' && github.ref_protected",
        environment: 'cannon-image-publish',
        'runs-on': 'ubuntu-24.04',
        'timeout-minutes': 30,
        concurrency: {
          group: `${service}-publish-\${{ github.sha }}`,
          'cancel-in-progress': false,
        },
        permissions: {
          'artifact-metadata': 'write',
          attestations: 'write',
          contents: 'read',
          'id-token': 'write',
          packages: 'write',
        },
        env: {
          IMAGE_NAME: imageName,
        },
        outputs: {
          digest: '${{ steps.push.outputs.digest }}',
          image_name: '${{ env.IMAGE_NAME }}',
          image_ref: '${{ env.IMAGE_NAME }}@${{ steps.push.outputs.digest }}',
        },
        steps: [
          {
            uses: CHECKOUT,
            with: {
              'persist-credentials': false,
            },
          },
          {
            name: 'Derive source-addressed image metadata',
            id: 'image-metadata',
            env: {
              IMAGE_REVISION: '${{ github.sha }}',
            },
            run:
              `bash ${scripts}/image-metadata.sh ` +
              '"${IMAGE_REVISION}" >> "${GITHUB_OUTPUT}"',
          },
          {
            uses: LOGIN,
            with: {
              registry: 'ghcr.io',
              username: '${{ github.actor }}',
              password: '${{ secrets.GITHUB_TOKEN }}',
            },
          },
          {
            uses: BUILDX,
          },
          {
            name: 'Build and publish the source-addressed image',
            id: 'push',
            uses: BUILD_PUSH,
            with: {
              context: `./packages/${service}`,
              file: `./packages/${service}/Dockerfile`,
              platforms: 'linux/amd64',
              pull: true,
              push: true,
              tags: '${{ env.IMAGE_NAME }}:${{ github.sha }}',
              'build-args':
                'VERSION=${{ steps.image-metadata.outputs.version }}\n' +
                'BUILD_REVISION=${{ steps.image-metadata.outputs.revision }}\n' +
                'BUILD_DATE=${{ steps.image-metadata.outputs.build_date }}\n' +
                'SOURCE_DATE_EPOCH=${{ steps.image-metadata.outputs.source_date_epoch }}\n',
              provenance: 'mode=max',
              sbom: true,
            },
          },
          {
            name: 'Verify the published manifest',
            env: {
              EXPECTED_BASE_DIGEST: BASE_DIGEST,
              EXPECTED_BASE_NAME: BASE_NAME,
              EXPECTED_BUILD_DATE:
                '${{ steps.image-metadata.outputs.build_date }}',
              EXPECTED_BUILD_REVISION:
                '${{ steps.image-metadata.outputs.revision }}',
              EXPECTED_SOURCE: SOURCE_URL,
              EXPECTED_SOURCE_DATE_EPOCH:
                '${{ steps.image-metadata.outputs.source_date_epoch }}',
              EXPECTED_VERSION: '${{ steps.image-metadata.outputs.version }}',
              IMAGE_DIGEST: '${{ steps.push.outputs.digest }}',
            },
            run:
              'docker pull "${IMAGE_NAME}@${IMAGE_DIGEST}"\n' +
              `bash ${scripts}/verify-image.sh ` +
              '"${IMAGE_NAME}@${IMAGE_DIGEST}"\n',
          },
          {
            name: 'Attest the published manifest',
            uses: ATTEST,
            with: {
              'subject-name': '${{ env.IMAGE_NAME }}',
              'subject-digest': '${{ steps.push.outputs.digest }}',
              'subject-version': '${{ steps.image-metadata.outputs.version }}',
              'push-to-registry': true,
              'create-storage-record': true,
            },
          },
          {
            name: 'Record the immutable image reference',
            env: {
              IMAGE_DIGEST: '${{ steps.push.outputs.digest }}',
            },
            run:
              '{\n' +
              `  echo '## ${summaryHeading}'\n` +
              '  echo\n' +
              '  echo "\\`${IMAGE_NAME}@${IMAGE_DIGEST}\\`"\n' +
              '} >> "$GITHUB_STEP_SUMMARY"\n',
          },
        ],
      },
    },
  };
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function parseWorkflow(source, workflowName) {
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
  });
  invariant(
    document.errors.length === 0,
    `${workflowName} is invalid YAML: ${document.errors
      .map((error) => error.message)
      .join('; ')}`
  );
  invariant(
    document.warnings.length === 0,
    `${workflowName} has YAML warnings: ${document.warnings
      .map((warning) => warning.message)
      .join('; ')}`
  );

  let workflow;
  try {
    workflow = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${workflowName} is unsafe YAML: ${message}`);
  }
  invariant(isRecord(workflow), `${workflowName} must be a mapping`);
  return workflow;
}

function firstDifference(expected, actual, path = 'workflow') {
  if (isDeepStrictEqual(expected, actual)) return undefined;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual))
      return `${path} must be an ordered list of reviewed steps`;
    if (expected.length !== actual.length) {
      return `${path} must contain exactly ${expected.length} reviewed entries`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index],
        actual[index],
        `${path}[${index}]`
      );
      if (difference) return difference;
    }
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return `${path} must be a mapping`;
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (!isDeepStrictEqual(expectedKeys, actualKeys)) {
      return `${path} keys must be exactly ${expectedKeys.join(', ')}`;
    }
    for (const key of expectedKeys) {
      const difference = firstDifference(
        expected[key],
        actual[key],
        `${path}.${key}`
      );
      if (difference) return difference;
    }
  }

  return `${path} must equal ${JSON.stringify(expected)}`;
}

function walkStrings(value, visit, path = 'workflow') {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkStrings(entry, visit, `${path}[${index}]`)
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    walkStrings(entry, visit, `${path}.${key}`);
  }
}

function assertNoSecretsContext(workflow, workflowName) {
  walkStrings(workflow, (value, path) => {
    invariant(
      !/\bsecrets\b/iu.test(value),
      `${workflowName} must not consume secrets at ${path}`
    );
  });
}

function assertPublisherSecretsContract(workflow, workflowName) {
  walkStrings(workflow, (value, path) => {
    const references = [
      ...value.matchAll(/\bsecrets(?:\s*\.\s*[A-Za-z0-9_]+)+/giu),
    ].map((match) => match[0].replace(/\s+/gu, ''));
    const withoutNamedReferences = references.reduce(
      (remaining, reference) => remaining.replace(reference, ''),
      value
    );
    invariant(
      !/\bsecrets\b/iu.test(withoutNamedReferences),
      `${workflowName} must not consume whole or computed secrets contexts at ${path}`
    );
    invariant(
      references.every((reference) => reference === 'secrets.GITHUB_TOKEN'),
      `${workflowName} must consume only secrets.GITHUB_TOKEN at ${path}`
    );
  });
}

function collectUses(value, uses = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectUses(entry, uses));
  } else if (isRecord(value)) {
    if (typeof value.uses === 'string') uses.push(value.uses);
    Object.values(value).forEach((entry) => collectUses(entry, uses));
  }
  return uses;
}

function assertPinnedRemoteActions(workflow, workflowName) {
  for (const action of collectUses(workflow)) {
    if (action.startsWith('./')) continue;
    const separator = action.lastIndexOf('@');
    invariant(
      separator !== -1,
      `${workflowName} has an unversioned action: ${action}`
    );
    invariant(
      /^[0-9a-f]{40}$/u.test(action.slice(separator + 1)),
      `${workflowName} action is not pinned to a commit SHA: ${action}`
    );
  }
}

function hasWritePermission(value, parentKey) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasWritePermission(entry, parentKey));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (parentKey === 'permissions' && entry === 'write') ||
      hasWritePermission(entry, key)
  );
}

function hasEnabledImagePush(value) {
  if (Array.isArray(value)) return value.some(hasEnabledImagePush);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      (key === 'push' && entry === true) || hasEnabledImagePush(entry)
  );
}

/**
 * @param {{
 *   descriptor: (typeof SERVICE_PUBLISHERS)[number],
 *   ciSource: string,
 *   publishSource: string,
 * }} input
 */
export function verifyServicePublisherWorkflow({
  descriptor,
  ciSource,
  publishSource,
}) {
  const { service } = descriptor;
  const ciName = `${service} CI`;
  const publisherName = `${service} publisher`;

  const ciWorkflow = parseWorkflow(ciSource, ciName);
  const publishWorkflow = parseWorkflow(publishSource, publisherName);

  invariant(
    isDeepStrictEqual(ciWorkflow.on, EXPECTED_CI_TRIGGERS),
    `${ciName} must be limited to pull requests, main pushes and trusted reusable calls`
  );
  invariant(
    isDeepStrictEqual(ciWorkflow.permissions, { contents: 'read' }),
    `${ciName} must remain read-only`
  );
  assertNoSecretsContext(ciWorkflow, ciName);
  invariant(
    !hasWritePermission(ciWorkflow),
    `${ciName} must not request write permissions`
  );
  const ciActions = collectUses(ciWorkflow);
  invariant(
    !ciActions.some((action) => action.startsWith('docker/login-action@')),
    `${ciName} must not log in to a registry`
  );
  invariant(
    !ciActions.some((action) => action.startsWith('docker/build-push-action@')),
    `${ciName} must not invoke a registry publisher`
  );
  invariant(
    !hasEnabledImagePush(ciWorkflow),
    `${ciName} must not push an image`
  );

  // The publisher only runs when this workflow succeeded, so the scan has to
  // live here. Without it the gate would attest to nothing.
  invariant(
    ciActions.some((action) =>
      action.startsWith('aquasecurity/trivy-action@')
    ),
    `${ciName} must scan the built image before the publisher can be gated on it`
  );

  assertPublisherSecretsContract(publishWorkflow, publisherName);
  const difference = firstDifference(
    expectedPublishWorkflow(descriptor),
    publishWorkflow,
    'publisher'
  );
  invariant(
    difference === undefined,
    `${publisherName} differs from the exact reviewed schema: ${difference}`
  );

  assertPinnedRemoteActions(ciWorkflow, ciName);
  assertPinnedRemoteActions(publishWorkflow, publisherName);
}

/**
 * @param {{ readFile?: (path: string) => string }} [options]
 */
export function verifyServicePublisherWorkflows({ readFile } = {}) {
  const read = readFile ?? ((path) => readFileSync(path, 'utf8'));
  for (const descriptor of SERVICE_PUBLISHERS) {
    verifyServicePublisherWorkflow({
      descriptor,
      ciSource: read(ciPathFor(descriptor.service)),
      publishSource: read(publishPathFor(descriptor.service)),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyServicePublisherWorkflows();
  process.stdout.write('Service publisher workflow policy passed\n');
}
