import { HttpError } from './errors';

type Waiting<T> = {
  reject: (error: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
  task: () => Promise<T>;
  timer: ReturnType<typeof setTimeout>;
};

export class WorkLimiter {
  private active = 0;
  private readonly waiting: Waiting<unknown>[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly maximumQueue: number,
    private readonly queueTimeoutMs: number
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) return this.start(task);
    if (this.waiting.length >= this.maximumQueue) {
      throw new HttpError(503, 'gateway_busy', 'RPC gateway capacity is temporarily exhausted');
    }
    return new Promise<T>((resolve, reject) => {
      const item: Waiting<T> = {
        reject,
        resolve,
        task,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(item as Waiting<unknown>);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new HttpError(503, 'gateway_busy', 'RPC gateway queue deadline was exceeded'));
        }, this.queueTimeoutMs),
      };
      this.waiting.push(item as Waiting<unknown>);
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.next();
    }
  }

  private next(): void {
    const item = this.waiting.shift();
    if (!item) return;
    clearTimeout(item.timer);
    void this.start(item.task).then(item.resolve, item.reject);
  }
}

type CostWindow = { startedAt: number; used: number };

export class WindowCostLimiter {
  private readonly limit: number;
  private readonly maximumKeys: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, CostWindow>();

  constructor(limit: number, windowMs: number, maximumKeys = 10_000) {
    this.limit = limit;
    this.maximumKeys = maximumKeys;
    this.windowMs = windowMs;
  }

  consume(key: string, cost: number, now = Date.now()): void {
    let window = this.windows.get(key);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (!window && this.windows.size >= this.maximumKeys) this.evict(now);
      if (!window && this.windows.size >= this.maximumKeys) {
        throw new HttpError(503, 'gateway_busy', 'RPC gateway limiter capacity is temporarily exhausted');
      }
      window = { startedAt: now, used: 0 };
      this.windows.set(key, window);
    }
    if (!Number.isSafeInteger(cost) || cost < 1 || window.used + cost > this.limit) {
      throw new HttpError(429, 'rate_limited', 'RPC method cost exceeds the current rate limit');
    }
    window.used += cost;
  }

  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) this.windows.delete(key);
    }
  }
}
