/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createArtifactFacadeClient } from '../src/artifact-client';
import { loadArtifactWorkerConfig } from '../src/worker-config';

type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchResponseInit = ConstructorParameters<typeof Response>[1];

function config(overrides: Record<string, string> = {}) {
  return loadArtifactWorkerConfig({
    ARTIFACT_SOURCE_URL: 'http://source.test',
    ARTIFACT_WRITER_TOKEN: 'writer-secret',
    ARTIFACT_WRITER_URL: 'http://writer.test',
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

function streamingResponse(chunks: Buffer[], init: FetchResponseInit = {}) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init
  );
}

describe('artifact facade HTTP client', () => {
  it('uses explicit endpoints, rejects redirects, authenticates only the writer, and supplies expected-cid', async () => {
    const requests: Array<{ init?: FetchRequestInit; url: URL }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      requests.push({ init, url });

      if (url.pathname === '/health' || url.pathname === '/health/write') {
        return Response.json({ status: 'ok' });
      }
      if (url.hostname === 'source.test') {
        return streamingResponse([Buffer.from('artifact')], { status: 200 });
      }
      return Response.json({ Hash: url.searchParams.get('expected-cid') });
    };
    const client = createArtifactFacadeClient(config(), fetchMock);

    await client.checkHealth();
    assert.deepEqual(await client.read('QmSource'), Buffer.from('artifact'));
    assert.equal(await client.write('QmExpected', Buffer.from('artifact')), 'QmExpected');

    assert.equal(
      requests.every(({ init }) => init?.redirect === 'error'),
      true
    );
    const writerHealth = requests.find(({ url }) => url.pathname === '/health/write');
    assert.equal(new Headers(writerHealth?.init?.headers).get('authorization'), 'Bearer writer-secret');
    const sourceRequest = requests.find(({ url }) => url.hostname === 'source.test' && url.pathname === '/api/v0/cat');
    assert.equal(new Headers(sourceRequest?.init?.headers).has('authorization'), false);
    const writerRequest = requests.find(({ url }) => url.pathname === '/api/v0/add');
    assert.equal(new Headers(writerRequest?.init?.headers).get('authorization'), 'Bearer writer-secret');
    assert.equal(writerRequest?.url.searchParams.get('expected-cid'), 'QmExpected');
    assert.ok(writerRequest?.init?.body instanceof FormData);
  });

  it('bounds a streaming source response even without content-length', async () => {
    const fetchMock: typeof fetch = async () => streamingResponse([Buffer.from('123'), Buffer.from('456')], { status: 200 });
    const client = createArtifactFacadeClient(
      config({
        ARTIFACT_MAX_COMPRESSED_BYTES: '5',
        ARTIFACT_MAX_FETCH_BYTES: '5',
        ARTIFACT_MAX_NODE_BYTES: '5',
      }),
      fetchMock
    );

    await assert.rejects(client.read('QmBounded'), /response limit/);
  });

  it('rejects oversized declared responses before consuming them', async () => {
    const fetchMock: typeof fetch = async () =>
      streamingResponse([Buffer.from('small')], { headers: { 'content-length': '999' }, status: 200 });
    const client = createArtifactFacadeClient(
      config({
        ARTIFACT_MAX_COMPRESSED_BYTES: '5',
        ARTIFACT_MAX_FETCH_BYTES: '5',
        ARTIFACT_MAX_NODE_BYTES: '5',
      }),
      fetchMock
    );

    await assert.rejects(client.read('QmBounded'), /response limit/);
  });

  it('aborts requests at the configured deadline without exposing the endpoint or token', async () => {
    const fetchMock: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('writer-secret https://writer.test')), {
          once: true,
        });
      });
    const client = createArtifactFacadeClient(
      config({ ARTIFACT_FETCH_TIMEOUT_MS: '10', ARTIFACT_READINESS_TIMEOUT_MS: '10' }),
      fetchMock
    );

    await assert.rejects(
      client.read('QmTimeout'),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'artifact source request timed out' &&
        !error.message.includes('writer-secret')
    );
  });

  it('keeps the deadline active while a streaming response body is stalled', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // The source sent headers but never produced or closed its body.
          },
        }),
        { status: 200 }
      );
    const client = createArtifactFacadeClient(config({ ARTIFACT_FETCH_TIMEOUT_MS: '10' }), fetchMock);

    await assert.rejects(client.read('QmStalled'), /artifact source response timed out/);
  });

  it('bounds and validates the writer response', async () => {
    const oversizedFetch: typeof fetch = async () => streamingResponse([Buffer.alloc(20)], { status: 200 });
    const oversizedClient = createArtifactFacadeClient(config({ ARTIFACT_MAX_WRITE_RESPONSE_BYTES: '10' }), oversizedFetch);
    await assert.rejects(oversizedClient.write('QmExpected', Buffer.from('data')), /response limit/);

    const invalidFetch: typeof fetch = async () => new Response('not json', { status: 200 });
    const invalidClient = createArtifactFacadeClient(config(), invalidFetch);
    await assert.rejects(invalidClient.write('QmExpected', Buffer.from('data')), /invalid response/);
  });
});
