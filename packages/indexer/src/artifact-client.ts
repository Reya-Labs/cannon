import type { ArtifactWorkerConfig } from './worker-config';

export interface ArtifactFacadeClient {
  checkHealth(): Promise<void>;
  read(cid: string): Promise<Buffer>;
  write(cid: string, data: Buffer): Promise<string>;
}

type FetchImplementation = typeof fetch;
type FetchRequestInit = NonNullable<Parameters<FetchImplementation>[1]>;
type FetchHeadersInit = FetchRequestInit['headers'];

class ResponseLimitError extends Error {}

function boundedIntegerHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBody(response: Response, maxBytes: number, label: string, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = boundedIntegerHeader(response.headers.get('content-length'));
  if (declaredLength !== null && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseLimitError(`${label} exceeded its response limit`);
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  let done = false;

  try {
    while (!done) {
      const result = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error(`${label} timed out`));
          return;
        }
        const onAbort = () => {
          reject(new Error(`${label} timed out`));
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        reader
          .read()
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
      done = result.done;
      if (done) break;
      const { value } = result;
      if (!value) continue;

      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseLimitError(`${label} exceeded its response limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ResponseLimitError) throw error;
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} timed out`);
    }
    throw new Error(`${label} failed`);
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, length);
}

async function requestWithDeadline(
  fetchImpl: FetchImplementation,
  url: URL,
  init: FetchRequestInit,
  timeoutMs: number,
  label: string
): Promise<{ finish: () => void; response: Response; signal: AbortSignal }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    return {
      finish: () => clearTimeout(timeout),
      response,
      signal: controller.signal,
    };
  } catch {
    clearTimeout(timeout);
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out`);
    }
    throw new Error(`${label} failed`);
  }
}

function healthUrl(origin: string) {
  return new URL('/health', origin);
}

function writerHealthUrl(origin: string) {
  return new URL('/health/write', origin);
}

function sourceCatUrl(origin: string, cid: string) {
  const url = new URL('/api/v0/cat', origin);
  url.searchParams.set('arg', cid);
  return url;
}

function writerAddUrl(origin: string, cid: string) {
  const url = new URL('/api/v0/add', origin);
  url.searchParams.set('local', 'true');
  url.searchParams.set('expected-cid', cid);
  url.searchParams.set('to-files', `/${cid}`);
  return url;
}

export function createArtifactFacadeClient(
  config: ArtifactWorkerConfig,
  fetchImpl: FetchImplementation = fetch
): ArtifactFacadeClient {
  async function checkEndpointHealth(url: URL, headers: FetchHeadersInit | undefined, label: string) {
    const request = await requestWithDeadline(
      fetchImpl,
      url,
      { headers, method: 'GET' },
      config.ARTIFACT_READINESS_TIMEOUT_MS,
      label
    );
    try {
      const body = await readBoundedBody(request.response, config.ARTIFACT_MAX_WRITE_RESPONSE_BYTES, label, request.signal);
      if (!request.response.ok) {
        throw new Error(`${label} returned HTTP ${request.response.status}`);
      }
      if (body.length === 0) {
        throw new Error(`${label} returned an empty response`);
      }
    } finally {
      request.finish();
    }
  }

  return {
    async checkHealth() {
      await Promise.all([
        checkEndpointHealth(healthUrl(config.ARTIFACT_SOURCE_URL), undefined, 'artifact source health check'),
        checkEndpointHealth(
          writerHealthUrl(config.ARTIFACT_WRITER_URL),
          { Authorization: `Bearer ${config.ARTIFACT_WRITER_TOKEN}` },
          'artifact writer health check'
        ),
      ]);
    },

    async read(cid: string) {
      const request = await requestWithDeadline(
        fetchImpl,
        sourceCatUrl(config.ARTIFACT_SOURCE_URL, cid),
        { method: 'POST' },
        config.ARTIFACT_FETCH_TIMEOUT_MS,
        'artifact source request'
      );

      try {
        if (!request.response.ok) {
          await request.response.body?.cancel().catch(() => undefined);
          throw new Error(`artifact source returned HTTP ${request.response.status}`);
        }

        return await readBoundedBody(
          request.response,
          config.ARTIFACT_MAX_FETCH_BYTES,
          'artifact source response',
          request.signal
        );
      } finally {
        request.finish();
      }
    },

    async write(cid: string, data: Buffer) {
      const form = new FormData();
      form.append('file', new Blob([data]), cid);

      const request = await requestWithDeadline(
        fetchImpl,
        writerAddUrl(config.ARTIFACT_WRITER_URL, cid),
        {
          body: form,
          headers: { Authorization: `Bearer ${config.ARTIFACT_WRITER_TOKEN}` },
          method: 'POST',
        },
        config.ARTIFACT_WRITE_TIMEOUT_MS,
        'artifact writer request'
      );
      try {
        const body = await readBoundedBody(
          request.response,
          config.ARTIFACT_MAX_WRITE_RESPONSE_BYTES,
          'artifact writer response',
          request.signal
        );

        if (!request.response.ok) {
          throw new Error(`artifact writer returned HTTP ${request.response.status}`);
        }

        let hash: unknown;
        try {
          hash = (JSON.parse(body.toString('utf8')) as { Hash?: unknown }).Hash;
        } catch {
          throw new Error('artifact writer returned an invalid response');
        }
        if (typeof hash !== 'string') {
          throw new Error('artifact writer returned an invalid response');
        }

        return hash;
      } finally {
        request.finish();
      }
    },
  };
}
