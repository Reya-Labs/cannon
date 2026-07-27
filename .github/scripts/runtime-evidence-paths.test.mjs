#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const scanner = join(scriptDirectory, 'scan-runtime-image.sh');
const generator = join(scriptDirectory, 'generate-expected-runtime-sbom.sh');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cannon-runtime-evidence-'));
const fakeBin = join(fixtureRoot, 'bin');
mkdirSync(fakeBin);
const fakeDocker = join(fakeBin, 'docker');
writeFileSync(fakeDocker, '#!/bin/sh\nexit 73\n');
chmodSync(fakeDocker, 0o755);
const testEnvironment = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
};
const revision = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();

const runScanner = (outputDirectory) =>
  spawnSync(
    'bash',
    [
      scanner,
      'local.invalid/cannon:test',
      'repo',
      '@usecannon/repo',
      '0.0.0-test',
      outputDirectory,
      'absent',
    ],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: testEnvironment,
    }
  );

const runGenerator = (outputPath) =>
  spawnSync('bash', [generator, repositoryRoot, revision, 'repo', outputPath], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: testEnvironment,
  });

try {
  const attackerDirectory = join(fixtureRoot, 'runtime-security-attacker');
  mkdirSync(attackerDirectory);
  writeFileSync(join(attackerDirectory, 'bundle-input-repo.cdx.json'), '{}\n');
  symlinkSync(
    'bundle-input-repo.cdx.json',
    join(attackerDirectory, 'expected-bundle-input-repo.cdx.json')
  );
  const existingDirectoryResult = runScanner(attackerDirectory);
  assert.equal(existingDirectoryResult.status, 2);
  assert.match(
    existingDirectoryResult.stderr,
    /runtime scan output directory must not already exist/
  );

  const realDirectory = join(fixtureRoot, 'real-runtime-security');
  const outputDirectorySymlink = join(fixtureRoot, 'runtime-security-link');
  mkdirSync(realDirectory);
  symlinkSync(realDirectory, outputDirectorySymlink);
  const symlinkDirectoryResult = runScanner(outputDirectorySymlink);
  assert.equal(symlinkDirectoryResult.status, 2);
  assert.match(
    symlinkDirectoryResult.stderr,
    /runtime scan output directory must not already exist/
  );

  const freshScanDirectory = join(fixtureRoot, 'runtime-security-fresh');
  const freshScanResult = runScanner(freshScanDirectory);
  assert.equal(
    freshScanResult.status,
    73,
    `fresh scanner fixture should reach fake Docker:\n${freshScanResult.stderr}`
  );
  assert.equal(lstatSync(freshScanDirectory).isSymbolicLink(), false);
  assert.equal(lstatSync(freshScanDirectory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(freshScanDirectory), []);

  const escapedGeneratorParent = join(fixtureRoot, 'real-expected');
  const generatorParentSymlink = join(fixtureRoot, 'runtime-expected-link');
  mkdirSync(escapedGeneratorParent);
  symlinkSync(escapedGeneratorParent, generatorParentSymlink);
  const symlinkGeneratorResult = runGenerator(
    join(generatorParentSymlink, 'repo.cdx.json')
  );
  assert.equal(symlinkGeneratorResult.status, 2);
  assert.match(
    symlinkGeneratorResult.stderr,
    /expected bundle-input output directory must not already exist/
  );
  assert.deepEqual(readdirSync(escapedGeneratorParent), []);

  const existingGeneratorParent = join(
    fixtureRoot,
    'runtime-expected-existing'
  );
  mkdirSync(existingGeneratorParent);
  symlinkSync(
    join(escapedGeneratorParent, 'attacker.cdx.json'),
    join(existingGeneratorParent, 'repo.cdx.json')
  );
  const existingGeneratorResult = runGenerator(
    join(existingGeneratorParent, 'repo.cdx.json')
  );
  assert.equal(existingGeneratorResult.status, 2);
  assert.match(
    existingGeneratorResult.stderr,
    /expected bundle-input output directory must not already exist/
  );

  const freshGeneratorParent = join(fixtureRoot, 'runtime-expected-fresh');
  const freshGeneratorResult = runGenerator(
    join(freshGeneratorParent, 'repo.cdx.json')
  );
  assert.equal(
    freshGeneratorResult.status,
    73,
    `fresh generator fixture should reach fake Docker:\n${freshGeneratorResult.stderr}`
  );
  assert.equal(lstatSync(freshGeneratorParent).isSymbolicLink(), false);
  assert.equal(lstatSync(freshGeneratorParent).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(freshGeneratorParent), []);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Runtime evidence path isolation tests passed.');
