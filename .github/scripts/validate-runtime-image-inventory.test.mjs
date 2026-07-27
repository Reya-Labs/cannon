#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  validateManualRuntimeImageRequest,
  validateRuntimeImageInventory,
} from './validate-runtime-image-inventory.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const revision = (character) => character.repeat(40);
const image = (runtime, character) =>
  `ghcr.io/reya-labs/${runtime}@${digest(character)}`;

const inactiveEntry = () => ({
  status: 'inactive',
  active: null,
  rollback: [],
});

const baseline = () => ({
  schemaVersion: 1,
  runtimes: {
    repo: inactiveEntry(),
    indexer: inactiveEntry(),
    api: inactiveEntry(),
    'safe-app-backend': inactiveEntry(),
  },
});

assert.deepEqual(validateRuntimeImageInventory(baseline()), { include: [] });

{
  const inventory = baseline();
  inventory.runtimes['safe-app-backend'] = {
    status: 'active',
    active: {
      imageRef: image('safe-app-backend', 'a'),
      sourceRevision: revision('b'),
    },
    rollback: [
      {
        imageRef: image('safe-app-backend', 'c'),
        sourceRevision: revision('d'),
      },
    ],
  };
  assert.deepEqual(validateRuntimeImageInventory(inventory), {
    include: [
      {
        runtime: 'safe-app-backend',
        slot: 'active',
        image_ref: image('safe-app-backend', 'a'),
        expected_revision: revision('b'),
        signer_workflow:
          'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
        signer_digest: revision('b'),
      },
      {
        runtime: 'safe-app-backend',
        slot: 'rollback-1',
        image_ref: image('safe-app-backend', 'c'),
        expected_revision: revision('d'),
        signer_workflow:
          'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
        signer_digest: revision('d'),
      },
    ],
  });
}

const assertRejected = (label, mutate, expectedMessage) => {
  const inventory = baseline();
  mutate(inventory);
  assert.throws(
    () => validateRuntimeImageInventory(inventory),
    (error) =>
      error instanceof Error && error.message.includes(expectedMessage),
    label
  );
};

assertRejected(
  'missing runtime entry',
  (inventory) => {
    delete inventory.runtimes.api;
  },
  'keys must be exactly'
);

assertRejected(
  'unreviewed inventory key',
  (inventory) => {
    inventory.note = 'skip scans';
  },
  'inventory keys must be exactly'
);

assertRejected(
  'inactive runtime with a hidden active digest',
  (inventory) => {
    inventory.runtimes['safe-app-backend'].active = {
      imageRef: image('safe-app-backend', 'a'),
      sourceRevision: revision('b'),
    };
  },
  'must have active null and no rollback entries while inactive'
);

assertRejected(
  'active runtime without a digest',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: null,
      rollback: [],
    };
  },
  'active is required while active'
);

assertRejected(
  'active runtime without a rollback',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: {
        imageRef: image('safe-app-backend', 'a'),
        sourceRevision: revision('b'),
      },
      rollback: [],
    };
  },
  'must contain one or two accepted rollback images'
);

assertRejected(
  'mutable image tag',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: {
        imageRef: 'ghcr.io/reya-labs/safe-app-backend:latest',
        sourceRevision: revision('b'),
      },
      rollback: [
        {
          imageRef: image('safe-app-backend', 'c'),
          sourceRevision: revision('d'),
        },
      ],
    };
  },
  'immutable sha256 digest'
);

assertRejected(
  'image destination substitution',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: {
        imageRef: `ghcr.io/attacker/safe-app-backend@${digest('a')}`,
        sourceRevision: revision('b'),
      },
      rollback: [
        {
          imageRef: image('safe-app-backend', 'c'),
          sourceRevision: revision('d'),
        },
      ],
    };
  },
  'selected Reya image'
);

assertRejected(
  'missing source revision',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: {
        imageRef: image('safe-app-backend', 'a'),
        sourceRevision: '',
      },
      rollback: [
        {
          imageRef: image('safe-app-backend', 'c'),
          sourceRevision: revision('d'),
        },
      ],
    };
  },
  '40-character Git revision'
);

assertRejected(
  'duplicate active and rollback digest',
  (inventory) => {
    inventory.runtimes['safe-app-backend'] = {
      status: 'active',
      active: {
        imageRef: image('safe-app-backend', 'a'),
        sourceRevision: revision('b'),
      },
      rollback: [
        {
          imageRef: image('safe-app-backend', 'a'),
          sourceRevision: revision('d'),
        },
      ],
    };
  },
  'duplicates another inventory digest'
);

assertRejected(
  'active runtime without an approved signer mapping',
  (inventory) => {
    inventory.runtimes.repo = {
      status: 'active',
      active: {
        imageRef: image('repo', 'a'),
        sourceRevision: revision('b'),
      },
      rollback: [
        {
          imageRef: image('repo', 'c'),
          sourceRevision: revision('d'),
        },
      ],
    };
  },
  'repo has no approved publisher workflow'
);

assert.deepEqual(
  validateManualRuntimeImageRequest(
    'safe-app-backend',
    image('safe-app-backend', 'a'),
    revision('b')
  ),
  {
    include: [
      {
        runtime: 'safe-app-backend',
        slot: 'candidate',
        image_ref: image('safe-app-backend', 'a'),
        expected_revision: revision('b'),
        signer_workflow:
          'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
        signer_digest: revision('b'),
      },
    ],
  }
);

assert.throws(
  () =>
    validateManualRuntimeImageRequest(
      'repo',
      image('repo', 'a'),
      revision('b')
    ),
  /repo has no approved publisher workflow/u
);

console.log('Runtime image inventory validation tests passed.');
