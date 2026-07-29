import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createLocalQaResolutionMap,
  LOCAL_QA_BASELINE,
  LOCAL_QA_FIXTURE_PATH,
  LOCAL_QA_PACKAGE_REFS,
  LOCAL_QA_SAFE_ADDRESS,
  LOCAL_QA_SOURCE,
  loadLocalQaResolutionManifest,
  resolveLocalQaPackage,
  validateLocalQaResolutionManifest,
} from '../test-support/local-qa-resolution.mjs';

test('loads the exact commit, Safe, baseline, and chain-13370 package fixture', async () => {
  const manifest = await loadLocalQaResolutionManifest();

  assert.equal(manifest.safeAddress, LOCAL_QA_SAFE_ADDRESS);
  assert.deepEqual(manifest.source, LOCAL_QA_SOURCE);
  assert.deepEqual(manifest.baseline, LOCAL_QA_BASELINE);
  assert.deepEqual(
    manifest.resolutions.map(({ fullPackageRef }) => fullPackageRef),
    LOCAL_QA_PACKAGE_REFS
  );
  assert.equal(manifest.resolutions.length, 19);
  assert.equal(
    manifest.resolutions.every(({ chainId }) => chainId === 13370),
    true
  );
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.resolutions), true);
});

test('resolves only pinned package and chain pairs without a fallback', async () => {
  const manifest = await loadLocalQaResolutionManifest();
  const resolutionMap = createLocalQaResolutionMap(manifest);

  assert.deepEqual(
    resolveLocalQaPackage(resolutionMap, {
      chainId: 13370,
      fullPackageRef: 'reya-core:1.0.26@router',
    }),
    {
      mutability: 'version',
      url: 'ipfs://QmNtBYSTjBuuhkGiptYswAumhUSPPtt1uZJcDPMq16ZLCo',
    }
  );
  assert.deepEqual(
    resolveLocalQaPackage(resolutionMap, {
      chainId: 13370,
      fullPackageRef: 'reya-tokens:1.0.0@proxy',
    }),
    {
      mutability: '',
      url: 'ipfs://QmZnhXheh8SgkRSuNbkx4BNfKCYUXvpY5bXqPUTYbSCHLL',
    }
  );
  assert.deepEqual(
    resolveLocalQaPackage(resolutionMap, {
      chainId: 1729,
      fullPackageRef: 'reya-omnibus:1.0.158@main',
    }),
    {
      mutability: 'version',
      url: 'ipfs://QmaXwNU4gdBwgx4nZDV7qsPCG2GQXhyKqvxWEQoiF7CmZN',
    }
  );
  assert.throws(
    () =>
      resolveLocalQaPackage(resolutionMap, {
        chainId: 1729,
        fullPackageRef: 'reya-core:1.0.26@router',
      }),
    /package resolution is not pinned/
  );
  assert.throws(
    () =>
      resolveLocalQaPackage(resolutionMap, {
        chainId: 13370,
        fullPackageRef: 'reya-core:latest@router',
      }),
    /package resolution is not pinned/
  );
});

test('rejects fixture tampering, alternate schemas, and non-canonical ordering', async () => {
  const fixture = JSON.parse(await readFile(LOCAL_QA_FIXTURE_PATH, 'utf8'));
  const cases = [];

  const wrongSafe = structuredClone(fixture);
  wrongSafe.safeAddress = '0x0000000000000000000000000000000000000001';
  cases.push(wrongSafe);

  const wrongBaseline = structuredClone(fixture);
  wrongBaseline.baseline.deployCid =
    'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
  cases.push(wrongBaseline);

  const wrongBlock = structuredClone(fixture);
  wrongBlock.registrySnapshots[0].blockNumber = '154866870';
  cases.push(wrongBlock);

  const floatingVersion = structuredClone(fixture);
  floatingVersion.resolutions[0].fullPackageRef =
    'reya-core:latest@router';
  cases.push(floatingVersion);

  const wrongChain = structuredClone(fixture);
  wrongChain.resolutions[0].chainId = 1729;
  cases.push(wrongChain);

  const duplicate = structuredClone(fixture);
  duplicate.resolutions[1] = structuredClone(duplicate.resolutions[0]);
  cases.push(duplicate);

  const reordered = structuredClone(fixture);
  reordered.resolutions.reverse();
  cases.push(reordered);

  const extraField = structuredClone(fixture);
  extraField.hostedFallback = 'https://repo.usecannon.com';
  cases.push(extraField);

  for (const candidate of cases) {
    assert.throws(
      () => validateLocalQaResolutionManifest(candidate),
      /local QA resolution fixture rejected/
    );
  }
});

test('rejects an oversized manifest before parsing it', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-manifest-limit-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const fixture = path.join(temporary, 'resolution.json');
  await writeFile(fixture, new Uint8Array(1024 * 1024 + 1));
  await assert.rejects(
    loadLocalQaResolutionManifest(fixture),
    /fixture cannot be read as JSON/
  );
});
