#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const runtimeNames = ['repo', 'indexer', 'api', 'safe-app-backend'];

export const approvedPublisherWorkflows = new Map([
  [
    'safe-app-backend',
    'Reya-Labs/cannon/.github/workflows/safe-app-backend-publish.yml',
  ],
]);

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const assertExactKeys = (value, expectedKeys, location) => {
  if (
    !isRecord(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())
  ) {
    throw new Error(
      `${location} keys must be exactly ${[...expectedKeys].sort().join(', ')}`
    );
  }
};

const validateArtifact = (value, runtime, location) => {
  assertExactKeys(value, ['imageRef', 'sourceRevision'], location);

  const expectedPrefix = `ghcr.io/reya-labs/${runtime}@sha256:`;
  if (
    typeof value.imageRef !== 'string' ||
    !value.imageRef.startsWith(expectedPrefix) ||
    !/^[0-9a-f]{64}$/u.test(value.imageRef.slice(expectedPrefix.length))
  ) {
    throw new Error(
      `${location}.imageRef must be the selected Reya image at an immutable sha256 digest`
    );
  }
  if (
    typeof value.sourceRevision !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(value.sourceRevision)
  ) {
    throw new Error(
      `${location}.sourceRevision must be a lowercase 40-character Git revision`
    );
  }

  const signerWorkflow = approvedPublisherWorkflows.get(runtime);
  if (signerWorkflow === undefined) {
    throw new Error(
      `${location} cannot be activated because ${runtime} has no approved publisher workflow`
    );
  }

  return {
    runtime,
    image_ref: value.imageRef,
    expected_revision: value.sourceRevision,
    signer_workflow: signerWorkflow,
    signer_digest: value.sourceRevision,
  };
};

export const validateRuntimeImageInventory = (inventory) => {
  assertExactKeys(inventory, ['runtimes', 'schemaVersion'], 'inventory');
  if (inventory.schemaVersion !== 1) {
    throw new Error('inventory.schemaVersion must be 1');
  }
  assertExactKeys(inventory.runtimes, runtimeNames, 'inventory.runtimes');

  const matrixEntries = [];
  const imageRefs = new Set();
  for (const runtime of runtimeNames) {
    const location = `inventory.runtimes.${runtime}`;
    const entry = inventory.runtimes[runtime];
    assertExactKeys(entry, ['active', 'rollback', 'status'], location);
    if (!Array.isArray(entry.rollback)) {
      throw new Error(`${location}.rollback must be an array`);
    }

    if (entry.status === 'inactive') {
      if (entry.active !== null || entry.rollback.length !== 0) {
        throw new Error(
          `${location} must have active null and no rollback entries while inactive`
        );
      }
      continue;
    }
    if (entry.status !== 'active') {
      throw new Error(`${location}.status must be active or inactive`);
    }
    if (entry.active === null) {
      throw new Error(`${location}.active is required while active`);
    }
    if (entry.rollback.length === 0 || entry.rollback.length > 2) {
      throw new Error(
        `${location}.rollback must contain one or two accepted rollback images while active`
      );
    }

    const artifacts = [
      ['active', entry.active],
      ...entry.rollback.map((artifact, index) => [
        `rollback-${index + 1}`,
        artifact,
      ]),
    ];
    for (const [slot, artifact] of artifacts) {
      const artifactLocation =
        slot === 'active'
          ? `${location}.active`
          : `${location}.rollback[${Number(slot.slice(9)) - 1}]`;
      const matrixEntry = validateArtifact(artifact, runtime, artifactLocation);
      if (imageRefs.has(matrixEntry.image_ref)) {
        throw new Error(
          `${artifactLocation}.imageRef duplicates another inventory digest`
        );
      }
      imageRefs.add(matrixEntry.image_ref);
      matrixEntries.push({ ...matrixEntry, slot });
    }
  }

  return { include: matrixEntries };
};

export const validateManualRuntimeImageRequest = (
  runtime,
  imageRef,
  sourceRevision
) => {
  if (!runtimeNames.includes(runtime)) {
    throw new Error(`unsupported runtime kind: ${runtime}`);
  }
  return {
    include: [
      {
        ...validateArtifact(
          { imageRef, sourceRevision },
          runtime,
          'manual request'
        ),
        slot: 'candidate',
      },
    ],
  };
};

const main = () => {
  const args = process.argv.slice(2);
  let matrix;
  if (args[0] === '--manual') {
    if (args.length !== 4) {
      throw new Error(
        'usage: validate-runtime-image-inventory.mjs --manual RUNTIME IMAGE_REF SOURCE_REVISION'
      );
    }
    matrix = validateManualRuntimeImageRequest(args[1], args[2], args[3]);
  } else {
    if (args.length !== 1) {
      throw new Error(
        'usage: validate-runtime-image-inventory.mjs INVENTORY_JSON'
      );
    }
    matrix = validateRuntimeImageInventory(
      JSON.parse(readFileSync(args[0], 'utf8'))
    );
  }
  process.stdout.write(`${JSON.stringify(matrix)}\n`);
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'inventory validation failed';
    console.error(`ERROR ${message}`);
    process.exitCode = 1;
  }
}
