import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSourceBundleReader,
  MAX_SOURCE_BYTES,
  SOURCE_ROOT,
  validateSourceBundle,
} from '../src/simulator/source.mjs';
import {
  COMMIT,
  jsonResponse,
  recordingFetch,
  sha256,
  SOURCE_ORIGIN,
  sourceBundle,
  streamOf,
  textResponse,
} from './simulator-support.mjs';

function reader(handler) {
  const fetchImpl = recordingFetch(handler);
  return {
    fetchImpl,
    reader: createSourceBundleReader({ fetchImpl, origin: SOURCE_ORIGIN }),
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

test('reads the pinned commit from the cluster-internal gateway', async () => {
  const bundle = sourceBundle();
  const { fetchImpl, reader: client } = reader(() => jsonResponse(bundle));
  const result = await client.bundle({ commit: COMMIT });

  assert.equal(
    fetchImpl.calls[0].url,
    `${SOURCE_ORIGIN}/source/reya-deployments/${COMMIT}/reya-network`,
  );
  assert.equal(fetchImpl.calls[0].options.method, 'GET');
  assert.equal(fetchImpl.calls[0].options.redirect, 'error');
  assert.equal(result.bundleSha256, bundle.bundleSha256);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.files.length, 1);
});

test('rejects a bundle whose file digest does not match its content', async () => {
  const bundle = sourceBundle();
  const tampered = {
    ...bundle,
    files: [{ ...bundle.files[0], content: 'name = "not-reya-omnibus"\n' }],
  };
  const { reader: client } = reader(() => jsonResponse(tampered));

  assert.equal(await code(client.bundle({ commit: COMMIT })), 'PREVIEW_FAILED');
});

test('rejects a bundle whose canonical digest does not match its files', async () => {
  const bundle = sourceBundle();
  const swapped = 'name = "reya-omnibus"\n# swapped\n';
  const tampered = {
    ...bundle,
    files: [{ content: swapped, path: SOURCE_ROOT, sha256: sha256(swapped) }],
  };

  // Each file still hashes to its own digest, so only the whole-bundle hash
  // catches this. That is the check a compromised gateway has to defeat.
  assert.equal(
    sha256(tampered.files[0].content),
    tampered.files[0].sha256,
    'the per-file digest must still be self-consistent',
  );
  const { reader: client } = reader(() => jsonResponse(tampered));
  assert.equal(await code(client.bundle({ commit: COMMIT })), 'PREVIEW_FAILED');
});

test('rejects a bundle served for a different commit', async () => {
  const bundle = sourceBundle({ commit: 'a'.repeat(40) });
  const { reader: client } = reader(() => jsonResponse(bundle));

  assert.equal(await code(client.bundle({ commit: COMMIT })), 'PREVIEW_FAILED');
});

test('rejects a bundle that omits the omnibus root', async () => {
  const bundle = sourceBundle({
    files: [
      { content: 'x = 1\n', path: 'packages/tomls/src/omnibus/other.toml' },
    ],
  });
  const { reader: client } = reader(() => jsonResponse(bundle));

  assert.equal(await code(client.bundle({ commit: COMMIT })), 'PREVIEW_FAILED');
});

test('rejects unsorted or duplicated file paths', () => {
  const bundle = sourceBundle();
  assert.throws(
    () =>
      validateSourceBundle(
        { ...bundle, files: [bundle.files[0], bundle.files[0]] },
        COMMIT,
      ),
    /PREVIEW_FAILED/,
  );
});

test('rejects a file path outside the pinned source root', () => {
  const content = 'x = 1\n';
  const files = [
    { content, path: '../../../etc/passwd.toml', sha256: sha256(content) },
  ];
  const canonical = {
    schemaVersion: 1,
    repository: 'Reya-Labs/reya-deployments',
    commit: COMMIT,
    root: SOURCE_ROOT,
    files,
  };
  assert.throws(
    () =>
      validateSourceBundle(
        {
          bundleSha256: sha256(JSON.stringify(canonical)),
          commit: COMMIT,
          files,
          repository: 'Reya-Labs/reya-deployments',
          root: SOURCE_ROOT,
          schemaVersion: 1,
        },
        COMMIT,
      ),
    /PREVIEW_FAILED/,
  );
});

test('rejects an unexpected key rather than ignoring it', () => {
  assert.throws(
    () => validateSourceBundle({ ...sourceBundle(), extra: 1 }, COMMIT),
    /PREVIEW_FAILED/,
  );
});

test('treats a non-JSON media type as an upstream failure', async () => {
  const { reader: client } = reader(() =>
    textResponse(JSON.stringify(sourceBundle()), 'text/html'),
  );

  assert.equal(
    await code(client.bundle({ commit: COMMIT })),
    'UPSTREAM_UNAVAILABLE',
  );
});

test('treats a redirected response as an upstream failure', async () => {
  const { reader: client } = reader(() =>
    jsonResponse(sourceBundle(), { redirected: true }),
  );

  assert.equal(
    await code(client.bundle({ commit: COMMIT })),
    'UPSTREAM_UNAVAILABLE',
  );
});

test('refuses a body larger than the source budget', async () => {
  const { reader: client } = reader(() => ({
    body: streamOf(new Uint8Array(16)),
    headers: new Headers({
      'content-length': String(MAX_SOURCE_BYTES + 1),
      'content-type': 'application/json',
    }),
    ok: true,
    redirected: false,
    status: 200,
  }));

  assert.equal(
    await code(client.bundle({ commit: COMMIT })),
    'UPSTREAM_UNAVAILABLE',
  );
});

test('refuses a streamed body that exceeds the budget without declaring it', async () => {
  const oversized = new Uint8Array(1024);
  const { reader: client } = reader(() => ({
    body: new ReadableStream({
      start(controller) {
        for (let index = 0; index < 12 * 1024; index += 1) {
          controller.enqueue(oversized);
        }
        controller.close();
      },
    }),
    headers: new Headers({ 'content-type': 'application/json' }),
    ok: true,
    redirected: false,
    status: 200,
  }));

  assert.equal(
    await code(client.bundle({ commit: COMMIT })),
    'UPSTREAM_UNAVAILABLE',
  );
});

test('refuses a commit the request layer would never have produced', async () => {
  const { reader: client } = reader(() => jsonResponse(sourceBundle()));

  await assert.rejects(
    () => client.bundle({ commit: '../../etc/passwd' }),
    /preview source commit is invalid/,
  );
});
