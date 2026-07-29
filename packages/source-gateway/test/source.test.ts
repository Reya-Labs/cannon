import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_LIMITS } from '../src/archive';
import { SourceBundleService } from '../src/source';

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
});
