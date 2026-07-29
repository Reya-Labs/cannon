import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleCannonDefinition } from '../src/runtime/assemble-definition.mjs';

const ROOT = 'packages/tomls/src/omnibus/reya_network.toml';

function source(path, content) {
  return { path, content };
}

test('assembles recursive includes with Cannon website precedence', () => {
  const bundle = {
    root: ROOT,
    files: [
      source(
        ROOT,
        `
include = ["./layers/base.toml", "./layers/override.toml"]
name = "root"

[invoke.shared]
func = "root"
args = ["root"]

[invoke.root_only]
func = "rootOnly"
`,
      ),
      source(
        'packages/tomls/src/omnibus/layers/base.toml',
        `
include = ["../../shared.toml"]
name = "base"

[invoke.shared]
target = ["0x0000000000000000000000000000000000000001"]
func = "base"
args = ["base"]

[invoke.base_only]
func = "baseOnly"
`,
      ),
      source(
        'packages/tomls/src/omnibus/layers/override.toml',
        `
[invoke.shared]
func = "override"

[invoke.override_only]
func = "overrideOnly"
`,
      ),
      source(
        'packages/tomls/src/shared.toml',
        `
[invoke.shared_from_nested]
func = "nested"
`,
      ),
    ],
  };

  const assembled = assembleCannonDefinition(bundle);

  assert.deepEqual(assembled, {
    name: 'root',
    invoke: {
      shared_from_nested: { func: 'nested' },
      shared: {
        target: ['0x0000000000000000000000000000000000000001'],
        func: 'root',
        args: ['root'],
      },
      base_only: { func: 'baseOnly' },
      override_only: { func: 'overrideOnly' },
      root_only: { func: 'rootOnly' },
    },
  });
  assert.equal(Object.hasOwn(assembled, 'include'), false);
});

test('normalizes relative include paths without mutating its source bundle', () => {
  const bundle = {
    root: ROOT,
    files: [
      source(
        ROOT,
        `
include = ["layers/./nested/../child.toml"]
[invoke.root]
func = "root"
`,
      ),
      source(
        'packages/tomls/src/omnibus/layers/child.toml',
        `
[invoke.child]
func = "child"
`,
      ),
    ],
  };
  const before = structuredClone(bundle);

  assert.deepEqual(assembleCannonDefinition(bundle), {
    invoke: {
      child: { func: 'child' },
      root: { func: 'root' },
    },
  });
  assert.deepEqual(bundle, before);
});

test('preserves TOML date value semantics while assembling', () => {
  const assembled = assembleCannonDefinition({
    root: ROOT,
    files: [
      source(
        ROOT,
        `
published = 1979-05-27
at = 07:32:00
`,
      ),
    ],
  });

  assert.equal(assembled.published.toISOString(), '1979-05-27');
  assert.equal(assembled.published.isDate, true);
  assert.equal(assembled.at.toISOString(), '07:32:00.000');
  assert.equal(assembled.at.isTime, true);
});

test('rejects self-referential and indirect include cycles', () => {
  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, 'include = ["reya_network.toml"]')],
      }),
    /include cycle/,
  );

  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [
          source(ROOT, 'include = ["a.toml"]'),
          source(
            'packages/tomls/src/omnibus/a.toml',
            'include = ["reya_network.toml"]',
          ),
        ],
      }),
    /include cycle/,
  );
});

test('rejects includes that escape the Cannon source root', () => {
  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, 'include = ["../../outside.toml"]')],
      }),
    /escapes source root/,
  );

  for (const includePath of ['/absolute.toml', 'C:\\outside.toml']) {
    assert.throws(
      () =>
        assembleCannonDefinition({
          root: ROOT,
          files: [source(ROOT, `include = ["${includePath}"]`)],
        }),
      /include path|TOML/,
    );
  }
});

test('rejects missing, duplicate, and unreachable source files', () => {
  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, 'include = ["missing.toml"]')],
      }),
    /include is missing/,
  );

  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, ''), source(ROOT, '')],
      }),
    /duplicated/,
  );

  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [
          source(ROOT, ''),
          source('packages/tomls/src/omnibus/unreachable.toml', ''),
        ],
      }),
    /unreachable/,
  );
});

test('rejects malformed TOML and malformed include declarations', () => {
  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, '[invoke')],
      }),
    /TOML is invalid/,
  );

  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, 'include = "child.toml"')],
      }),
    /include list/,
  );

  assert.throws(
    () =>
      assembleCannonDefinition({
        root: ROOT,
        files: [source(ROOT, 'include = [1]')],
      }),
    /include list/,
  );
});

test('rejects prototype-polluting definition keys', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () =>
        assembleCannonDefinition({
          root: ROOT,
          files: [
            source(
              ROOT,
              `
["${key}"]
polluted = true
`,
            ),
          ],
        }),
      /forbidden key/,
    );
  }
  assert.equal({}.polluted, undefined);
});
