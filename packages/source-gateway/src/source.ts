import { fetchTomlArchive, type ArchiveLimits, ARCHIVE_LIMITS } from './archive';
import { encodeSourceBundle, type EncodedBundle } from './bundle';
import { HttpError } from './errors';

const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_ENTRIES = 16;
const MAX_CONCURRENT_FETCHES = 4;
const MAX_QUEUED_FETCHES = 32;
const MAX_QUEUE_WAIT_MS = 15_000;

type CachedBundle = Pick<EncodedBundle, 'body' | 'etag'> & {
  bytes: number;
};

class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_FETCHES) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= MAX_QUEUED_FETCHES) {
      throw new HttpError(503, 'source_gateway_busy', 'source gateway is busy');
    }
    await new Promise<void>((resolve, reject) => {
      let completed = false;
      const ready = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        if (completed) return;
        completed = true;
        const index = this.waiting.indexOf(ready);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new HttpError(503, 'source_gateway_busy', 'source gateway queue wait timed out'));
      }, MAX_QUEUE_WAIT_MS);
      this.waiting.push(ready);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }
}

export class SourceBundleService {
  private readonly cache = new Map<string, CachedBundle>();
  private cacheBytes = 0;
  private readonly gate = new Gate();
  private readonly inFlight = new Map<string, Promise<CachedBundle>>();

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly limits: Readonly<ArchiveLimits> = ARCHIVE_LIMITS
  ) {}

  async get(commit: string): Promise<Pick<EncodedBundle, 'body' | 'etag'>> {
    const cached = this.cache.get(commit);
    if (cached) {
      this.cache.delete(commit);
      this.cache.set(commit, cached);
      return cached;
    }
    const existing = this.inFlight.get(commit);
    if (existing) return existing;

    const loading = this.gate
      .run(async () => encodeSourceBundle(commit, await fetchTomlArchive(commit, this.fetchImpl, this.limits)))
      .then(({ body, etag }) => {
        const cachedBundle: CachedBundle = {
          body,
          bytes: Buffer.byteLength(body),
          etag,
        };
        this.cache.set(commit, cachedBundle);
        this.cacheBytes += cachedBundle.bytes;
        while (this.cache.size > CACHE_ENTRIES || this.cacheBytes > CACHE_BYTES) {
          const oldest = this.cache.entries().next().value as [string, CachedBundle] | undefined;
          if (oldest === undefined) break;
          this.cache.delete(oldest[0]);
          this.cacheBytes -= oldest[1].bytes;
        }
        return cachedBundle;
      })
      .finally(() => this.inFlight.delete(commit));
    this.inFlight.set(commit, loading);
    return loading;
  }
}
