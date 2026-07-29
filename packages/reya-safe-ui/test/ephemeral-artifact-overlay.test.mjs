import assert from 'node:assert/strict';
import test from 'node:test';
import { createEphemeralArtifactOverlay } from '../src/runtime/ephemeral-artifact-overlay.mjs';

test('ephemeral overlay produces stable Cannon CIDs without external writes', async () => {
  const allowedCids = new Set();
  const reads = [];
  const overlay = createEphemeralArtifactOverlay({
    allowedCids,
    baseLoader: {
      async read(url) {
        reads.push(url);
        return { base: true };
      },
    },
  });
  const value = { artifacts: { Example: { bytecode: '0x00' } } };
  const first = await overlay.loader.put(value);
  const second = await overlay.loader.put(value);
  assert.equal(first, second);
  assert.deepEqual(await overlay.loader.read(first), value);
  assert.deepEqual(await overlay.loader.list(), [first]);
  assert.equal(allowedCids.has(first.slice('ipfs://'.length)), true);
  assert.deepEqual(reads, []);
});

test('ephemeral overlay delegates immutable cache reads and rejects removal', async () => {
  const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
  const overlay = createEphemeralArtifactOverlay({
    allowedCids: new Set([cid]),
    baseLoader: {
      async read(url) {
        return { url };
      },
    },
  });
  assert.deepEqual(await overlay.loader.read(`ipfs://${cid}`), {
    url: `ipfs://${cid}`,
  });
  assert.throws(() => overlay.loader.remove(), /cannot be removed/);
});

test('ephemeral overlay bounds JSON before cloning or compression', async () => {
  const overlay = createEphemeralArtifactOverlay({
    allowedCids: new Set(),
    baseLoader: {
      async read() {
        throw new Error('must not read');
      },
    },
    maximumArtifactBytes: 64,
    maximumTotalBytes: 128,
  });
  await assert.rejects(
    overlay.loader.put({ value: 'x'.repeat(65) }),
    /bytes exceed their limit/
  );
  await assert.rejects(
    overlay.loader.put({ value: '\u0000'.repeat(11) }),
    /bytes exceed their limit/
  );

  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    overlay.loader.put(cyclic),
    /bytes exceed their limit|structural limits|not JSON serializable/
  );
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      throw new Error('must not invoke');
    },
  });
  await assert.rejects(
    overlay.loader.put(accessor),
    /not JSON serializable/
  );
});
