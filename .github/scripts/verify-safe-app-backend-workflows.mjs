import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const CI_PATH = '.github/workflows/safe-app-backend.yml';
const PUBLISH_PATH = '.github/workflows/safe-app-backend-publish.yml';

const EXPECTED_CI_TRIGGERS = {
  pull_request: {
    branches: ['dev', 'main'],
  },
  push: {
    branches: ['main'],
  },
  workflow_call: null,
};

// This is intentionally an exact, parsed policy contract. The publisher runs
// with package, OIDC and attestation write authority, so allowing an extra
// field, step, command or action input would silently expand that authority.
const EXPECTED_PUBLISH_WORKFLOW = {
  name: 'Publish Safe-app-backend image',
  on: {
    push: {
      branches: ['dev'],
    },
  },
  permissions: {
    contents: 'read',
  },
  jobs: {
    'safe-app-backend': {
      permissions: {
        contents: 'read',
      },
      uses: './.github/workflows/safe-app-backend.yml',
    },
    'publish-safe-app-backend': {
      needs: 'safe-app-backend',
      if:
        "needs.safe-app-backend.result == 'success' && " +
        "vars.CANNON_SAFE_PUBLISH_ENABLED == 'true' && " +
        "github.repository == 'Reya-Labs/cannon' && " +
        "github.event_name == 'push' && " +
        "github.ref == 'refs/heads/dev' && github.ref_protected",
      environment: 'cannon-image-publish',
      'runs-on': 'ubuntu-24.04',
      'timeout-minutes': 30,
      concurrency: {
        group: 'safe-app-backend-publish-${{ github.sha }}',
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
        IMAGE_NAME: 'ghcr.io/reya-labs/safe-app-backend',
      },
      outputs: {
        digest: '${{ steps.push.outputs.digest }}',
        image_name: '${{ env.IMAGE_NAME }}',
        image_ref: '${{ env.IMAGE_NAME }}@${{ steps.push.outputs.digest }}',
      },
      steps: [
        {
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
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
            'bash packages/safe-app-backend/scripts/image-metadata.sh ' +
            '"${IMAGE_REVISION}" >> "${GITHUB_OUTPUT}"',
        },
        {
          uses: 'docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7',
          with: {
            registry: 'ghcr.io',
            username: '${{ github.actor }}',
            password: '${{ secrets.GITHUB_TOKEN }}',
          },
        },
        {
          uses: 'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
        },
        {
          name: 'Build and publish the source-addressed image',
          id: 'push',
          uses: 'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
          with: {
            context: './packages/safe-app-backend',
            file: './packages/safe-app-backend/Dockerfile',
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
            EXPECTED_BASE_DIGEST:
              'sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2',
            EXPECTED_BASE_NAME: 'node:22.23.1-alpine',
            EXPECTED_BUILD_DATE:
              '${{ steps.image-metadata.outputs.build_date }}',
            EXPECTED_BUILD_REVISION:
              '${{ steps.image-metadata.outputs.revision }}',
            EXPECTED_SOURCE: 'https://github.com/Reya-Labs/cannon',
            EXPECTED_SOURCE_DATE_EPOCH:
              '${{ steps.image-metadata.outputs.source_date_epoch }}',
            EXPECTED_VERSION: '${{ steps.image-metadata.outputs.version }}',
            IMAGE_DIGEST: '${{ steps.push.outputs.digest }}',
          },
          run:
            'docker pull "${IMAGE_NAME}@${IMAGE_DIGEST}"\n' +
            'bash packages/safe-app-backend/scripts/verify-image.sh ' +
            '"${IMAGE_NAME}@${IMAGE_DIGEST}"\n',
        },
        {
          name: 'Attest the published manifest',
          uses: 'actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6',
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
            "  echo '## Safe app backend image'\n" +
            '  echo\n' +
            '  echo "\\`${IMAGE_NAME}@${IMAGE_DIGEST}\\`"\n' +
            '} >> "$GITHUB_STEP_SUMMARY"\n',
        },
      ],
    },
  },
};

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

function assertPublisherSecretsContract(workflow) {
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
      `Publisher must not consume whole or computed secrets contexts at ${path}`
    );
    invariant(
      references.every((reference) => reference === 'secrets.GITHUB_TOKEN'),
      `Publisher must consume only secrets.GITHUB_TOKEN at ${path}`
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

export function verifySafeAppBackendWorkflows({ ciSource, publishSource }) {
  const ciWorkflow = parseWorkflow(ciSource, 'Safe backend CI');
  const publishWorkflow = parseWorkflow(
    publishSource,
    'Safe backend publisher'
  );

  invariant(
    isDeepStrictEqual(ciWorkflow.on, EXPECTED_CI_TRIGGERS),
    'Safe backend CI must be limited to pull requests, main pushes and trusted reusable calls'
  );
  invariant(
    isDeepStrictEqual(ciWorkflow.permissions, { contents: 'read' }),
    'Safe backend CI must remain read-only'
  );
  assertNoSecretsContext(ciWorkflow, 'Safe backend CI');
  invariant(
    !hasWritePermission(ciWorkflow),
    'Safe backend CI must not request write permissions'
  );
  const ciActions = collectUses(ciWorkflow);
  invariant(
    !ciActions.some((action) => action.startsWith('docker/login-action@')),
    'Safe backend CI must not log in to a registry'
  );
  invariant(
    !ciActions.some((action) => action.startsWith('docker/build-push-action@')),
    'Safe backend CI must not invoke a registry publisher'
  );
  invariant(
    !hasEnabledImagePush(ciWorkflow),
    'Safe backend CI must not push an image'
  );

  assertPublisherSecretsContract(publishWorkflow);
  const difference = firstDifference(
    EXPECTED_PUBLISH_WORKFLOW,
    publishWorkflow,
    'publisher'
  );
  invariant(
    difference === undefined,
    `Publisher workflow differs from the exact reviewed schema: ${difference}`
  );

  assertPinnedRemoteActions(ciWorkflow, 'Safe backend CI');
  assertPinnedRemoteActions(publishWorkflow, 'Safe backend publisher');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySafeAppBackendWorkflows({
    ciSource: readFileSync(CI_PATH, 'utf8'),
    publishSource: readFileSync(PUBLISH_PATH, 'utf8'),
  });
  process.stdout.write('Safe backend workflow policy passed\n');
}
