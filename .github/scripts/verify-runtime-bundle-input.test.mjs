#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { verifyRuntimeBundleInput } from './verify-runtime-bundle-input.mjs';

const expectedObject = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  metadata: {
    component: {
      name: '@usecannon/repo',
      version: '2.22.0',
    },
  },
  components: [
    {
      type: 'library',
      name: 'first',
      version: '1.0.0',
      purl: 'pkg:npm/first@1.0.0',
    },
    {
      type: 'library',
      name: 'second',
      version: '2.0.0',
      purl: 'pkg:npm/second@2.0.0',
    },
  ],
};
const expected = Buffer.from(`${JSON.stringify(expectedObject, null, 2)}\n`);
const expectedDigest = createHash('sha256').update(expected).digest('hex');

assert.equal(
  verifyRuntimeBundleInput(expected, Buffer.from(expected)),
  expectedDigest,
  'byte-identical source and embedded closures must pass'
);

{
  const truncatedObject = structuredClone(expectedObject);
  truncatedObject.components.pop();
  const truncated = Buffer.from(
    `${JSON.stringify(truncatedObject, null, 2)}\n`
  );
  assert.doesNotThrow(
    () => JSON.parse(truncated),
    'post-generation mutation fixture must remain valid JSON'
  );
  assert.throws(
    () => verifyRuntimeBundleInput(expected, truncated),
    /differs from the independently generated source closure/u,
    'a plausible post-generation closure truncation must fail closed'
  );
}

assert.throws(
  () =>
    verifyRuntimeBundleInput(
      expected,
      Buffer.from(JSON.stringify(expectedObject))
    ),
  /differs from the independently generated source closure/u,
  'semantically similar but byte-different evidence must be rejected'
);

assert.throws(
  () => verifyRuntimeBundleInput(Buffer.alloc(0), Buffer.alloc(0)),
  /must not be empty/u
);

console.log('Runtime bundle-input binding tests passed.');
