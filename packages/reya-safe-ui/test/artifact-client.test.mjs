import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARTIFACT_CAT_PATH,
  createReyaReadOnlyClients,
  REYA_READ_LIMITS,
  ReyaReadClientError,
} from '../src/clients/index.mjs';
import {
  byteResponse,
  clientWith,
  DEPLOY_CID,
  SERVICE_ORIGIN,
  streamResponse,
  verifyAbiSelector,
} from '../test-support/client-fixtures.mjs';

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('reads only Kubo cat through the consolidated origin and verifies content CID', async () => {
  const artifact = new Uint8Array([0, 1, 2, 3, 254, 255]);
  let verifierBytes;
  let request;
  const client = createReyaReadOnlyClients({
    fetchImpl: async (url, options) => {
      request = { options, url };
      return byteResponse(artifact);
    },
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async (bytes) => {
      verifierBytes = bytes;
      return DEPLOY_CID;
    },
  });

  const result = await client.artifacts.cat({ cid: DEPLOY_CID });

  assert.deepEqual(result, artifact);
  assert.deepEqual(verifierBytes, artifact);
  assert.equal(
    request.url,
    `${SERVICE_ORIGIN}${ARTIFACT_CAT_PATH}?arg=${DEPLOY_CID}`
  );
  assert.equal(new URL(request.url).origin, SERVICE_ORIGIN);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.headers.Accept, 'application/octet-stream');
  assert.equal('Authorization' in request.options.headers, false);
  assert.equal('body' in request.options, false);
});

for (const cid of [
  '',
  'Qm',
  `Qm${'1'.repeat(44)}`,
  `Qm${'z'.repeat(44)}`,
  DEPLOY_CID.toLowerCase(),
  `ipfs://${DEPLOY_CID}`,
  'bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354',
]) {
  test(`rejects non-canonical CIDv0 input ${cid || '<empty>'}`, async () => {
    const client = clientWith(async () => {
      throw new Error('invalid CID must not reach fetch');
    });
    await assert.rejects(
      () => client.artifacts.cat({ cid }),
      assertClientError('INVALID_INPUT')
    );
  });
}

test('rejects extra artifact request fields, including write credentials', async () => {
  const client = clientWith(async () => {
    throw new Error('invalid input must not reach fetch');
  });
  for (const input of [
    { cid: DEPLOY_CID, bearerToken: 'secret' },
    { cid: DEPLOY_CID, upload: true },
    { arg: DEPLOY_CID },
    null,
  ]) {
    await assert.rejects(
      () => client.artifacts.cat(input),
      assertClientError('INVALID_INPUT')
    );
  }
  await assert.rejects(
    () => client.artifacts.cat({ cid: DEPLOY_CID }, {}),
    assertClientError('INVALID_INPUT')
  );
});

test('fails closed when the verifier rejects, throws, or returns a malformed CID', async () => {
  for (const verifyArtifactCid of [
    async () => 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
    async () => 'not-a-cid',
    async () => {
      throw new Error('verifier leaked implementation details');
    },
  ]) {
    const client = createReyaReadOnlyClients({
      fetchImpl: async () => byteResponse(new Uint8Array([1, 2, 3])),
      serviceOrigin: SERVICE_ORIGIN,
      verifyAbiSelector,
      verifyArtifactCid,
    });
    await assert.rejects(
      () => client.artifacts.cat({ cid: DEPLOY_CID }),
      (error) => {
        assertClientError('ARTIFACT_MISMATCH')(error);
        assert.equal(error.message, 'Artifact integrity verification failed.');
        assert.doesNotMatch(error.message, /verifier|implementation/i);
        return true;
      }
    );
  }
});

test('does not let the injected verifier mutate returned artifact bytes', async () => {
  const artifact = new Uint8Array([1, 2, 3]);
  const client = createReyaReadOnlyClients({
    fetchImpl: async () => byteResponse(artifact),
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async (bytes) => {
      bytes.fill(0);
      return DEPLOY_CID;
    },
  });

  assert.deepEqual(await client.artifacts.cat({ cid: DEPLOY_CID }), artifact);
});

test('enforces media type plus declared and streamed byte caps', async () => {
  const oversizedChunks = Array.from(
    { length: 51 },
    () => new Uint8Array(1024 * 1024)
  );
  const cases = [
    byteResponse(new Uint8Array([1]), {
      headers: { 'content-type': 'text/plain' },
    }),
    byteResponse(new Uint8Array([1]), {
      headers: {
        'content-length': String(REYA_READ_LIMITS.artifactBytes + 1),
      },
    }),
    streamResponse(oversizedChunks),
  ];

  for (const response of cases) {
    const client = clientWith(async () => response);
    await assert.rejects(
      () => client.artifacts.cat({ cid: DEPLOY_CID }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('accepts a bounded chunked artifact without Content-Length', async () => {
  const chunks = [
    new Uint8Array([1, 2]),
    new Uint8Array([3]),
    new Uint8Array([4, 5]),
  ];
  const client = createReyaReadOnlyClients({
    fetchImpl: async () => streamResponse(chunks),
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async (bytes) => {
      assert.deepEqual(bytes, new Uint8Array([1, 2, 3, 4, 5]));
      return DEPLOY_CID;
    },
  });

  assert.deepEqual(
    await client.artifacts.cat({ cid: DEPLOY_CID }),
    new Uint8Array([1, 2, 3, 4, 5])
  );
});

test('rejects and cancels a response with a pathological chunk count', async () => {
  let cancellations = 0;
  let chunks = 0;
  const stream = new ReadableStream({
    cancel() {
      cancellations += 1;
    },
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(0));
    },
  });
  const client = clientWith(
    async () =>
      new Response(stream, {
        headers: { 'content-type': 'application/octet-stream' },
      })
  );

  await assert.rejects(
    () => client.artifacts.cat({ cid: DEPLOY_CID }),
    assertClientError('RESPONSE_REJECTED')
  );
  assert.ok(chunks >= REYA_READ_LIMITS.responseChunks + 1);
  assert.ok(chunks <= REYA_READ_LIMITS.responseChunks + 2);
  assert.equal(cancellations, 1);
});

test('redacts repository HTTP, redirect, and network failures without fallback', async () => {
  const secret = 'stored artifact at /private/bucket/key does not exist';
  const responses = [
    new Response(secret, {
      headers: { 'content-type': 'text/plain' },
      status: 404,
    }),
    (() => {
      const response = byteResponse(new Uint8Array([1]));
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    })(),
  ];

  for (const response of responses) {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return response;
    });
    await assert.rejects(
      () => client.artifacts.cat({ cid: DEPLOY_CID }),
      (error) => {
        assertClientError('REQUEST_FAILED')(error);
        assert.doesNotMatch(error.message, /bucket|private|404/i);
        return true;
      }
    );
    assert.equal(calls, 1);
  }

  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error(secret);
  });
  await assert.rejects(
    () => client.artifacts.cat({ cid: DEPLOY_CID }),
    (error) => {
      assertClientError('REQUEST_FAILED')(error);
      assert.doesNotMatch(error.message, /bucket|private/i);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('applies the artifact deadline through a stalled response stream', async () => {
  const client = createReyaReadOnlyClients({
    deadlines: {
      artifactDeadlineMs: 15,
      queryDeadlineMs: 25,
    },
    fetchImpl: async (_url, options) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          options.signal.addEventListener(
            'abort',
            () => controller.error(new Error('stream aborted')),
            { once: true }
          );
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async () => DEPLOY_CID,
  });

  await assert.rejects(
    () => client.artifacts.cat({ cid: DEPLOY_CID }),
    assertClientError('REQUEST_TIMEOUT')
  );
});

test('links broker cancellation to the underlying artifact fetch', async () => {
  const controller = new AbortController();
  let fetchSignal;
  const client = createReyaReadOnlyClients({
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('fetch aborted')),
          { once: true }
        );
      });
    },
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async () => DEPLOY_CID,
  });

  const request = client.artifacts.cat(
    { cid: DEPLOY_CID },
    { signal: controller.signal }
  );
  controller.abort();

  await assert.rejects(request, assertClientError('REQUEST_FAILED'));
  assert.equal(fetchSignal.aborted, true);
});
