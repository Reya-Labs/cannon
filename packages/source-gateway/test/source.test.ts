import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS } from '../src/archive';
import { SourceBundleService } from '../src/source';
import { archive } from './fixtures';

function commit(index: number): string {
  return index.toString(16).padStart(40, '0');
}

describe('source bundle concurrency gate', () => {
  afterEach(() => vi.useRealTimers());

  it('fails a queued fetch instead of retaining stale work indefinitely', async () => {
    vi.useFakeTimers();
    const service = new SourceBundleService(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      { ...ARCHIVE_LIMITS, timeoutMs: 15_000 }
    );
    const occupying = [0, 1, 2, 3].map((index) => service.get(commit(index)).catch(() => undefined));
    const queued = service.get(commit(4)).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(queued).resolves.toMatchObject({
      code: 'source_gateway_busy',
      status: 503,
    });
    await Promise.all(occupying);
  });

  it('never exceeds the fetch cap while handing permits directly to queued work', async () => {
    const commits = Array.from({ length: 8 }, (_, index) => commit(index + 16));
    const archives = new Map<string, Buffer>(
      await Promise.all(
        commits.map(
          async (sha) =>
            [
              sha,
              await archive(sha, [
                {
                  body: 'version = "1"\n',
                  name: `reya-deployments-${sha}/packages/tomls/src/omnibus/reya_network.toml`,
                },
              ]),
            ] as const
        )
      )
    );
    let active = 0;
    let maximumActive = 0;
    const releaseBodies: Array<() => void> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const sha = String(url).split('/').at(-1)!;
      const bytes = archives.get(sha)!;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            releaseBodies.push(() => {
              active -= 1;
              controller.enqueue(bytes);
              controller.close();
            });
          },
        }),
        { headers: { 'content-type': 'application/gzip' } }
      );
    });
    const service = new SourceBundleService(fetchImpl as typeof fetch);
    const pending = commits.map((sha) => service.get(sha));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    for (let expectedCalls = 5; expectedCalls <= commits.length; expectedCalls += 1) {
      releaseBodies.shift()!();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(expectedCalls));
      expect(active).toBeLessThanOrEqual(4);
    }
    for (const release of releaseBodies.splice(0)) release();
    await Promise.all(pending);

    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
  });
});
