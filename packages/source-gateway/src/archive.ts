import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';
import tar from 'tar-stream';
import { COMMIT_PATTERN, SOURCE_PREFIX } from './constants';
import { HttpError } from './errors';

export type ArchiveLimits = {
  compressedBytes: number;
  decompressedBytes: number;
  entries: number;
  fileBytes: number;
  sourceBytes: number;
  timeoutMs: number;
};

/**
 * Fail-closed limits applied while downloading and unpacking a GitHub source archive.
 */
export const ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  compressedBytes: 8 * 1024 * 1024,
  decompressedBytes: 32 * 1024 * 1024,
  entries: 2_048,
  fileBytes: 512 * 1024,
  sourceBytes: 4 * 1024 * 1024,
  timeoutMs: 15_000,
});

const ALLOWED_MEDIA_TYPES = new Set(['application/gzip', 'application/octet-stream', 'application/x-gzip']);

function reject(message: string): never {
  throw new HttpError(502, 'source_archive_rejected', message);
}

function parseContentLength(headers: Headers, maximum: number): void {
  const value = headers.get('content-length');
  if (value === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) > maximum) {
    reject('upstream archive length is invalid');
  }
}

function validateMediaType(headers: Headers): void {
  const contentType = headers.get('content-type');
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (!mediaType || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    reject('upstream archive media type is invalid');
  }
  const encoding = headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    reject('upstream archive must not apply HTTP content encoding');
  }
}

async function* boundedBody(response: Response, maximum: number): AsyncGenerator<Buffer> {
  if (!response.body) reject('upstream archive body is missing');
  const reader = response.body.getReader();
  let completed = false;
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) reject('upstream archive body chunk is invalid');
      total += result.value.byteLength;
      if (total > maximum) reject('upstream archive exceeds the compressed byte limit');
      yield Buffer.from(result.value);
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The request has already failed closed; cancellation is best effort.
      }
    }
    reader.releaseLock();
  }
}

function canonicalArchivePath(name: string, expectedRoot: string, type: string): string | undefined {
  if (!name || name.includes('\0') || name.includes('\\') || name.includes('\ufffd') || name.startsWith('/')) {
    reject('archive entry path is invalid');
  }
  const candidate = type === 'directory' && name.endsWith('/') ? name.slice(0, -1) : name;
  if (
    !candidate ||
    posix.normalize(candidate) !== candidate ||
    candidate.split('/').some((part) => !part || part === '..')
  ) {
    reject('archive entry path is not canonical');
  }
  if (candidate === expectedRoot) return undefined;
  if (!candidate.startsWith(`${expectedRoot}/`)) reject('archive contains an unexpected root');
  return candidate.slice(expectedRoot.length + 1);
}

async function readEntry(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    let bytes: Buffer;
    if (typeof chunk === 'string') {
      bytes = Buffer.from(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      bytes = chunk;
    } else {
      bytes = Buffer.from(chunk as unknown as Uint8Array);
    }
    total += bytes.length;
    if (total > maximum) reject('archive file exceeds the per-file byte limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function drainEntry(stream: Readable, maximum: number): Promise<void> {
  let total = 0;
  for await (const chunk of stream) {
    total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (total > maximum) reject('archive file exceeds the per-file byte limit');
  }
}

/**
 * Downloads one immutable reya-deployments commit and returns only its TOML files.
 *
 * The archive URL is fixed and credential-free. All headers, paths, entry types,
 * stream sizes, and decoded text are validated before source is returned.
 */
export async function fetchTomlArchive(
  commit: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  limits: Readonly<ArchiveLimits> = ARCHIVE_LIMITS
): Promise<Map<string, string>> {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new HttpError(400, 'invalid_commit', 'commit must be a lowercase full Git SHA');
  }
  const expectedRoot = `reya-deployments-${commit}`;
  const upstream = `https://codeload.github.com/Reya-Labs/reya-deployments/tar.gz/${commit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  let response: Response | undefined;

  try {
    response = await fetchImpl(upstream, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/gzip' },
      method: 'GET',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected) {
      reject('upstream archive request failed');
    }
    parseContentLength(response.headers, limits.compressedBytes);
    validateMediaType(response.headers);

    const files = new Map<string, string>();
    const seen = new Set<string>();
    let entries = 0;
    let sourceBytes = 0;
    let decompressedBytes = 0;
    const decompressedCounter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        decompressedBytes += chunk.length;
        callback(
          decompressedBytes > limits.decompressedBytes
            ? new HttpError(502, 'source_archive_rejected', 'archive exceeds the decompressed byte limit')
            : undefined,
          chunk
        );
      },
    });
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        entries += 1;
        if (entries > limits.entries) reject('archive contains too many entries');
        if (header.type !== 'file' && header.type !== 'directory') {
          reject('archive contains a forbidden entry type');
        }
        const relative = canonicalArchivePath(header.name, expectedRoot, header.type);
        if (relative !== undefined) {
          if (seen.has(relative)) reject('archive contains a duplicate path');
          seen.add(relative);
        }
        if (header.type === 'directory') {
          await drainEntry(stream, 0);
          return;
        }
        const declaredSize = header.size;
        if (
          !Number.isSafeInteger(declaredSize) ||
          declaredSize === undefined ||
          declaredSize < 0 ||
          declaredSize > limits.decompressedBytes
        ) {
          reject('archive file declares an invalid size');
        }
        if (!relative?.startsWith(SOURCE_PREFIX) || !relative.endsWith('.toml')) {
          await drainEntry(stream, limits.decompressedBytes);
          return;
        }
        if (declaredSize > limits.fileBytes) reject('archive file declares an invalid size');
        const bytes = await readEntry(stream, limits.fileBytes);
        sourceBytes += bytes.length;
        if (sourceBytes > limits.sourceBytes) reject('archive TOML content exceeds the source byte limit');
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          reject('archive TOML content is not valid UTF-8');
        }
        files.set(relative, content);
      })()
        .then(next)
        .catch((error) => extract.destroy(error as Error));
    });

    await pipeline(
      Readable.from(boundedBody(response, limits.compressedBytes)),
      createGunzip(),
      decompressedCounter,
      extract
    );
    return files;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) {
      throw new HttpError(504, 'source_upstream_timeout', 'source archive request timed out');
    }
    throw new HttpError(502, 'source_upstream_failed', 'source archive request failed');
  } finally {
    clearTimeout(timeout);
    if (response?.body && !response.body.locked) {
      try {
        await response.body.cancel();
      } catch {
        // The request has already failed closed; cancellation is best effort.
      }
    }
  }
}
