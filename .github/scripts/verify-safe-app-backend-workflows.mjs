import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CI_PATH = '.github/workflows/safe-app-backend.yml';
const PUBLISH_PATH = '.github/workflows/safe-app-backend-publish.yml';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function topLevelBlock(source, heading) {
  const lines = source.split('\n');
  const start = lines.indexOf(`${heading}:`);
  invariant(start !== -1, `${heading} block is missing`);

  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end])))
    end += 1;
  return lines.slice(start, end).join('\n').trimEnd();
}

function assertPinnedRemoteActions(source, workflowName) {
  for (const match of source.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gm)) {
    const action = match[1];
    if (action.startsWith('./')) continue;
    const separator = action.lastIndexOf('@');
    invariant(
      separator !== -1,
      `${workflowName} has an unversioned action: ${action}`
    );
    invariant(
      /^[0-9a-f]{40}$/.test(action.slice(separator + 1)),
      `${workflowName} action is not pinned to a commit SHA: ${action}`
    );
  }
}

export function verifySafeAppBackendWorkflows({ ciSource, publishSource }) {
  const expectedCiTriggers = `on:
  pull_request:
    branches:
      - dev
      - main
  push:
    branches:
      - main
  workflow_call:`;
  invariant(
    topLevelBlock(ciSource, 'on') === expectedCiTriggers,
    'Safe backend CI must be limited to pull requests, main pushes and trusted reusable calls'
  );
  invariant(
    topLevelBlock(ciSource, 'permissions') === 'permissions:\n  contents: read',
    'Safe backend CI must remain read-only'
  );
  invariant(
    !/\bsecrets\./.test(ciSource),
    'Safe backend CI must not consume secrets'
  );
  invariant(
    !/^\s+\w[\w-]*:\s+write\s*$/m.test(ciSource),
    'Safe backend CI must not request write permissions'
  );
  invariant(
    !/docker\/login-action/.test(ciSource),
    'Safe backend CI must not log in to a registry'
  );
  invariant(
    !/docker\/build-push-action/.test(ciSource),
    'Safe backend CI must not invoke a registry publisher'
  );
  invariant(
    !/^\s+push:\s+true\s*$/m.test(ciSource),
    'Safe backend CI must not push an image'
  );

  const expectedPublishTrigger = `on:
  push:
    branches:
      - dev`;
  invariant(
    topLevelBlock(publishSource, 'on') === expectedPublishTrigger,
    'Image publication must only be triggered by a push to dev'
  );
  invariant(
    topLevelBlock(publishSource, 'permissions') ===
      'permissions:\n  contents: read',
    'Publisher workflow permissions must default to read-only'
  );
  invariant(
    !/\bworkflow_dispatch\b/.test(publishSource),
    'Manual image publication must remain disabled'
  );
  invariant(
    !/\bpull_request(?:_target)?\b/.test(publishSource),
    'Pull requests must not reach the publisher'
  );

  const expectedGate = `    if: >-
      needs.safe-app-backend.result == 'success' &&
      vars.CANNON_SAFE_PUBLISH_ENABLED == 'true' &&
      github.repository == 'Reya-Labs/cannon' &&
      github.event_name == 'push' &&
      github.ref == 'refs/heads/dev' &&
      github.ref_protected`;
  invariant(
    publishSource.includes(expectedGate),
    'Publisher trust and default-off gates have changed'
  );
  invariant(
    publishSource.includes('    environment: cannon-image-publish'),
    'Publisher must use the protected cannon-image-publish environment'
  );
  invariant(
    publishSource.includes('      password: ${{ secrets.GITHUB_TOKEN }}'),
    'GHCR login must use the job-scoped GitHub token'
  );
  invariant(
    (publishSource.match(/\bsecrets\.[A-Za-z0-9_]+/g) ?? []).join(',') ===
      'secrets.GITHUB_TOKEN',
    'Publisher must not consume repository or environment secrets'
  );
  invariant(
    (publishSource.match(/^\s+push:\s+true\s*$/gm) ?? []).length === 1,
    'Publisher must contain exactly one image push'
  );
  invariant(
    publishSource.includes('          persist-credentials: false'),
    'Publisher checkout must not persist GitHub credentials'
  );

  assertPinnedRemoteActions(ciSource, 'Safe backend CI');
  assertPinnedRemoteActions(publishSource, 'Safe backend publisher');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifySafeAppBackendWorkflows({
    ciSource: readFileSync(CI_PATH, 'utf8'),
    publishSource: readFileSync(PUBLISH_PATH, 'utf8'),
  });
  process.stdout.write('Safe backend workflow policy passed\n');
}
