#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateBundleInputSbom } from './generate-bundle-input-sbom.mjs';

const fixtures = new Set();

const packageFixture = (root, directory, name, version) => {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'package.json'),
    `${JSON.stringify({ name, version })}\n`
  );
  return path;
};

const pnpmListFixture = (dependencies) => [
  {
    name: '@usecannon/repo',
    version: '2.0.0',
    dependencies,
  },
];

test.afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { force: true, recursive: true });
  }
  fixtures.clear();
});

test('emits a stable, deduplicated CycloneDX bundle-input closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannon-runtime-sbom-'));
  fixtures.add(root);
  const workspace = packageFixture(
    root,
    'packages/builder',
    '@usecannon/builder',
    '2.26.1'
  );
  const example = packageFixture(
    root,
    'node_modules/example',
    'example',
    '1.2.3'
  );
  const scoped = packageFixture(
    root,
    'node_modules/@scope/example',
    '@scope/example',
    '2.0.0'
  );

  const sbom = generateBundleInputSbom({
    componentName: '@usecannon/repo',
    componentVersion: '2.0.0',
    pnpmList: pnpmListFixture({
      example: {
        version: '1.2.3',
        path: example,
        dependencies: {
          '@scope/example': {
            version: '2.0.0',
            path: scoped,
            dependencies: {
              example: { version: '1.2.3', path: example },
            },
          },
        },
      },
      '@usecannon/builder': {
        version: 'link:../builder',
        path: workspace,
      },
    }),
    repositoryRoot: root,
  });

  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.6');
  assert.deepEqual(
    sbom.components.map(({ purl }) => purl),
    [
      'pkg:npm/%40scope/example@2.0.0',
      'pkg:npm/%40usecannon/builder@2.26.1',
      'pkg:npm/example@1.2.3',
    ]
  );
  assert.equal(sbom.metadata.component.name, '@usecannon/repo');
  assert.deepEqual(sbom.metadata.properties, [
    {
      name: 'io.reya.cannon.bundle-input-selection',
      value: 'pnpm list --prod --no-optional --depth Infinity --json',
    },
  ]);
});

test('rejects dependency paths outside the repository root', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannon-runtime-sbom-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'cannon-runtime-sbom-outside-'));
  fixtures.add(root);
  fixtures.add(outside);
  const outsideWorkspace = packageFixture(
    outside,
    'package',
    '@usecannon/builder',
    '2.26.1'
  );

  assert.throws(
    () =>
      generateBundleInputSbom({
        componentName: '@usecannon/repo',
        componentVersion: '2.0.0',
        pnpmList: pnpmListFixture({
          '@usecannon/builder': {
            version: 'link:../builder',
            path: outsideWorkspace,
          },
        }),
        repositoryRoot: root,
      }),
    /escapes the repository root/u
  );
});

test('rejects empty and incomplete dependency closures', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannon-runtime-sbom-empty-'));
  fixtures.add(root);

  assert.throws(
    () =>
      generateBundleInputSbom({
        componentName: '@usecannon/repo',
        componentVersion: '2.0.0',
        pnpmList: pnpmListFixture({}),
        repositoryRoot: root,
      }),
    /must not be empty/u
  );
  assert.throws(
    () =>
      generateBundleInputSbom({
        componentName: '@usecannon/repo',
        componentVersion: '2.0.0',
        pnpmList: pnpmListFixture({
          incomplete: {},
        }),
        repositoryRoot: root,
      }),
    /metadata is incomplete/u
  );
  assert.throws(
    () =>
      generateBundleInputSbom({
        componentName: '@usecannon/repo',
        componentVersion: '2.0.0',
        pnpmList: [{ name: '@usecannon/api', version: '2.0.0' }],
        repositoryRoot: root,
      }),
    /root must exactly match/u
  );
});

test('rejects excluded dependency classes in the pnpm inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'cannon-runtime-sbom-optional-'));
  fixtures.add(root);

  assert.throws(
    () =>
      generateBundleInputSbom({
        componentName: '@usecannon/repo',
        componentVersion: '2.0.0',
        pnpmList: pnpmListFixture({
          example: {
            version: '1.2.3',
            optionalDependencies: {
              native: { version: '1.0.0' },
            },
          },
        }),
        repositoryRoot: root,
      }),
    /excluded dependency classes/u
  );
});
