import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compress,
  getContentCID,
} from '@usecannon/artifact-codec';
import { createReadOnlyArtifactLoader } from '../src/runtime/artifact-loader.mjs';

async function artifact(value) {
  const bytes = compress(JSON.stringify(value));
  return {
    bytes,
    cid: await getContentCID(bytes),
  };
}

test('artifact loader verifies and decodes one immutable CID', async () => {
  const expected = { status: 'complete', state: { value: 1 } };
  const encoded = await artifact(expected);
  const reads = [];
  const loader = createReadOnlyArtifactLoader({
    maximumBytes: encoded.bytes.byteLength,
    async readArtifact(cid) {
      reads.push(cid);
      return encoded.bytes;
    },
  });

  assert.deepEqual(await loader.read(`ipfs://${encoded.cid}`), expected);
  assert.deepEqual(reads, [encoded.cid]);
  assert.equal(loader.getLabel(), 'verified read-only artifact broker');
});

test('artifact loader rejects a mismatched CID and malformed payload', async () => {
  const encoded = await artifact({ status: 'complete' });
  const other = await artifact({ status: 'different' });
  const mismatched = createReadOnlyArtifactLoader({
    maximumBytes: 1_024,
    async readArtifact() {
      return other.bytes;
    },
  });
  await assert.rejects(
    mismatched.read(`ipfs://${encoded.cid}`),
    /CID verification failed/
  );

  const malformed = new Uint8Array([1, 2, 3]);
  const malformedCid = await getContentCID(malformed);
  const invalid = createReadOnlyArtifactLoader({
    maximumBytes: 1_024,
    async readArtifact() {
      return malformed;
    },
  });
  await assert.rejects(
    invalid.read(`ipfs://${malformedCid}`),
    /payload is invalid/
  );
});

test('artifact loader rejects noncanonical URLs, oversize reads, and writes', async () => {
  const encoded = await artifact({ ok: true });
  const loader = createReadOnlyArtifactLoader({
    maximumBytes: encoded.bytes.byteLength - 1,
    async readArtifact() {
      return encoded.bytes;
    },
  });

  await assert.rejects(loader.read(encoded.cid), /URL is invalid/);
  await assert.rejects(
    loader.read(`ipfs://${encoded.cid}?fallback=true`),
    /URL is invalid/
  );
  await assert.rejects(
    loader.read(`ipfs://${encoded.cid}`),
    /bytes are invalid/
  );
  assert.throws(() => loader.put({}), /read-only/);
  assert.throws(() => loader.remove(`ipfs://${encoded.cid}`), /read-only/);
  assert.throws(() => loader.list(), /read-only/);
});

test('artifact loader rejects option accessors, extra fields, and forbidden JSON keys', async () => {
  assert.throws(
    () =>
      createReadOnlyArtifactLoader({
        readArtifact() {},
        fallbackOrigin: 'https://example.invalid',
      }),
    /options are invalid/
  );
  const accessor = {};
  Object.defineProperty(accessor, 'readArtifact', {
    enumerable: true,
    get() {
      throw new Error('must not run');
    },
  });
  assert.throws(
    () => createReadOnlyArtifactLoader(accessor),
    /options are invalid/
  );

  const encoded = await artifact(
    JSON.parse('{"status":"complete","__proto__":{"polluted":true}}')
  );
  const loader = createReadOnlyArtifactLoader({
    async readArtifact() {
      return encoded.bytes;
    },
  });
  await assert.rejects(
    loader.read(`ipfs://${encoded.cid}`),
    /forbidden key/
  );
});
