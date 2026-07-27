#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

export const verifyRuntimeBundleInput = (expected, embedded) => {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(embedded)) {
    throw new Error('expected and embedded bundle inputs must be buffers');
  }
  if (expected.length === 0 || embedded.length === 0) {
    throw new Error('expected and embedded bundle inputs must not be empty');
  }

  const expectedDigest = sha256(expected);
  const embeddedDigest = sha256(embedded);
  if (!expected.equals(embedded)) {
    throw new Error(
      `embedded bundle-input SBOM differs from the independently generated source closure (expected sha256:${expectedDigest}, embedded sha256:${embeddedDigest})`
    );
  }
  return expectedDigest;
};

const main = () => {
  if (process.argv.length !== 4) {
    throw new Error(
      'usage: verify-runtime-bundle-input.mjs EXPECTED_SBOM EMBEDDED_SBOM'
    );
  }
  const expected = readFileSync(process.argv[2]);
  const embedded = readFileSync(process.argv[3]);
  process.stdout.write(`${verifyRuntimeBundleInput(expected, embedded)}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'bundle-input verification failed';
    console.error(`ERROR ${message}`);
    process.exitCode = 1;
  }
}
