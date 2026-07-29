import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS, fetchTomlArchive } from '../src/archive';
import { archive, archiveResponse, COMMIT, ROOT, ROOT_TOML } from './fixtures';

describe('GitHub source archive', () => {
  afterEach(() => vi.useRealTimers());

  it('uses only the fixed credential-free codeload URL and extracts TOML source', async () => {
    const bytes = await archive(COMMIT, [
      { name: `${ROOT}/`, type: 'directory' },
      { body: 'version = "1"\n', name: ROOT_TOML },
      { body: 'ignored', name: `${ROOT}/README.md` },
    ]);
    const fetchImpl = vi.fn(async () => archiveResponse(bytes));

    const files = await fetchTomlArchive(COMMIT, fetchImpl as typeof fetch);

    expect(files).toEqual(new Map([['packages/tomls/src/omnibus/reya_network.toml', 'version = "1"\n']]));
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://codeload.github.com/Reya-Labs/reya-deployments/tar.gz/${COMMIT}`);
    expect(options).toMatchObject({
      cache: 'no-store',
      credentials: 'omit',
      method: 'GET',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect((options?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it.each([
    ['moving ref', 'main', async () => archiveResponse(Buffer.alloc(0))],
    [
      'redirect',
      COMMIT,
      async () => {
        const response = archiveResponse(Buffer.alloc(0));
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      },
    ],
    ['wrong media type', COMMIT, async () => archiveResponse(Buffer.alloc(0), { headers: { 'content-type': 'text/html' } })],
    [
      'oversized declaration',
      COMMIT,
      async () =>
        archiveResponse(Buffer.alloc(0), {
          headers: { 'content-length': String(ARCHIVE_LIMITS.compressedBytes + 1) },
        }),
    ],
  ] as const)('rejects %s', async (_name, commit, fetchImpl) => {
    await expect(fetchTomlArchive(commit, fetchImpl as typeof fetch)).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it.each([
    { name: '../outside.toml' },
    { name: `${ROOT}/packages/tomls/src/../../outside.toml` },
    { name: `${ROOT}\\packages\\tomls\\src\\outside.toml` },
    { name: `${ROOT}/packages/tomls/src/link.toml`, type: 'symlink' as const },
  ])('rejects unsafe archive entry $name', async (entry) => {
    const bytes = await archive(COMMIT, [entry]);
    await expect(fetchTomlArchive(COMMIT, async () => archiveResponse(bytes))).rejects.toMatchObject({
      code: 'source_archive_rejected',
    });
  });

  it('enforces compressed, decompressed, entry, file, and aggregate TOML limits', async () => {
    const cases: Array<{ bytes: Buffer; limits: typeof ARCHIVE_LIMITS }> = [];
    const rootBytes = await archive(COMMIT, [{ body: 'version = "1"\n', name: ROOT_TOML }]);
    cases.push({
      bytes: rootBytes,
      limits: { ...ARCHIVE_LIMITS, compressedBytes: rootBytes.length - 1 },
    });
    cases.push({
      bytes: rootBytes,
      limits: { ...ARCHIVE_LIMITS, decompressedBytes: 1 },
    });
    cases.push({
      bytes: rootBytes,
      limits: { ...ARCHIVE_LIMITS, entries: 0 },
    });
    cases.push({
      bytes: rootBytes,
      limits: { ...ARCHIVE_LIMITS, fileBytes: 1 },
    });
    cases.push({
      bytes: rootBytes,
      limits: { ...ARCHIVE_LIMITS, sourceBytes: 1 },
    });

    for (const { bytes, limits } of cases) {
      await expect(fetchTomlArchive(COMMIT, async () => archiveResponse(bytes), limits)).rejects.toMatchObject({
        code: 'source_archive_rejected',
      });
    }
  });

  it('rejects invalid UTF-8 and duplicate canonical paths', async () => {
    for (const entries of [
      [{ body: Buffer.from([0xff]), name: ROOT_TOML }],
      [
        { body: 'version = "1"\n', name: ROOT_TOML },
        { body: 'version = "2"\n', name: ROOT_TOML },
      ],
    ]) {
      const bytes = await archive(COMMIT, entries);
      await expect(fetchTomlArchive(COMMIT, async () => archiveResponse(bytes))).rejects.toMatchObject({
        code: 'source_archive_rejected',
      });
    }
  });

  it('drains an irrelevant file without applying the selected-TOML memory cap', async () => {
    const bytes = await archive(COMMIT, [
      { body: 'version = "1"\n', name: ROOT_TOML },
      { body: Buffer.alloc(1024, 1), name: `${ROOT}/large-irrelevant.bin` },
    ]);
    const files = await fetchTomlArchive(COMMIT, async () => archiveResponse(bytes), {
      ...ARCHIVE_LIMITS,
      fileBytes: 32,
    });
    expect(files.get('packages/tomls/src/omnibus/reya_network.toml')).toBe('version = "1"\n');
  });

  it('enforces the streamed compressed limit without Content-Length', async () => {
    const bytes = await archive(COMMIT, [{ body: 'version = "1"\n', name: ROOT_TOML }]);
    await expect(
      fetchTomlArchive(
        COMMIT,
        async () =>
          new Response(bytes, {
            headers: { 'content-type': 'application/gzip' },
          }),
        { ...ARCHIVE_LIMITS, compressedBytes: bytes.length - 1 }
      )
    ).rejects.toMatchObject({ code: 'source_archive_rejected' });
  });

  it('aborts a stalled upstream request at the configured deadline', async () => {
    vi.useFakeTimers();
    const pending = fetchTomlArchive(
      COMMIT,
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      { ...ARCHIVE_LIMITS, timeoutMs: 10 }
    );
    const result = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({
      code: 'source_upstream_timeout',
      status: 504,
    });
  });
});
