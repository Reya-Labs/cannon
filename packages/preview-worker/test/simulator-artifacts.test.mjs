import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createArtifactReader,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_READS,
} from '../src/simulator/artifacts.mjs';
import {
  ARTIFACT_ORIGIN,
  OTHER_CID,
  PREVIOUS_CID,
  recordingFetch,
  streamOf,
  textResponse,
} from './simulator-support.mjs';

const PAYLOAD = new TextEncoder().encode('artifact-bytes');

function build({ getContentCid = async () => PREVIOUS_CID, handler } = {}) {
  const fetchImpl = recordingFetch(
    handler ?? (() => textResponse(PAYLOAD, 'application/octet-stream')),
  );
  return {
    fetchImpl,
    reader: createArtifactReader({
      fetchImpl,
      getContentCid,
      origin: ARTIFACT_ORIGIN,
    }),
  };
}

async function code(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

test('reads one artifact through the Kubo-compatible cat route', async () => {
  const { fetchImpl, reader } = build();
  const bytes = await reader.read(PREVIOUS_CID);

  assert.equal(
    fetchImpl.calls[0].url,
    `${ARTIFACT_ORIGIN}/artifacts/api/v0/cat?arg=${PREVIOUS_CID}`,
  );
  assert.equal(fetchImpl.calls[0].options.method, 'POST');
  assert.equal(fetchImpl.calls[0].options.redirect, 'error');
  assert.equal(
    fetchImpl.calls[0].options.headers.accept,
    'application/octet-stream',
  );
  assert.deepEqual([...bytes], [...PAYLOAD]);
  assert.equal(reader.reads, 1);
});

test('rejects bytes that do not hash to the requested CID', async () => {
  const { reader } = build({ getContentCid: async () => OTHER_CID });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'PREVIEW_FAILED');
});

test('rejects an artifact whose CID cannot be computed at all', async () => {
  const { reader } = build({
    getContentCid: async () => {
      throw new Error('codec exploded');
    },
  });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'PREVIEW_FAILED');
});

test('rejects a non-string CID result from the codec', async () => {
  const { reader } = build({ getContentCid: async () => 42 });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'PREVIEW_FAILED');
});

test('never treats an empty body as a valid artifact', async () => {
  const { reader } = build({
    getContentCid: async () => PREVIOUS_CID,
    handler: () => textResponse(new Uint8Array(0), 'application/octet-stream'),
  });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'PREVIEW_FAILED');
});

test('refuses a body larger than the artifact budget', async () => {
  const { reader } = build({
    handler: () => ({
      body: streamOf(PAYLOAD),
      headers: new Headers({
        'content-length': String(MAX_ARTIFACT_BYTES + 1),
        'content-type': 'application/octet-stream',
      }),
      ok: true,
      redirected: false,
      status: 200,
    }),
  });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'UPSTREAM_UNAVAILABLE');
});

test('treats a JSON error page as an upstream failure, not an artifact', async () => {
  const { reader } = build({
    handler: () => textResponse('{"error":"nope"}', 'application/json'),
  });

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'UPSTREAM_UNAVAILABLE');
});

test('rejects a CID that is not a canonical CIDv0', async () => {
  const { reader } = build();

  await assert.rejects(
    () => reader.read('../../etc/passwd'),
    /preview artifact CID is invalid/,
  );
  await assert.rejects(
    () => reader.read(`${PREVIOUS_CID}?arg=other`),
    /preview artifact CID is invalid/,
  );
});

test('bounds how many artifacts one preview may read', async () => {
  const { reader } = build();
  for (let index = 0; index < MAX_ARTIFACT_READS; index += 1) {
    await reader.read(PREVIOUS_CID);
  }

  assert.equal(await code(reader.read(PREVIOUS_CID)), 'PREVIEW_FAILED');
});
