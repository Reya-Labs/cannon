import { describe, expect, it } from 'vitest';
import { WindowCostLimiter, WorkLimiter } from '../src/limits';

describe('WorkLimiter', () => {
  it('bounds active work, queue length, and queue wait time', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const limiter = new WorkLimiter(1, 1, 10);
    const active = limiter.run(async () => {
      await blocked;
      return 'active';
    });
    const queued = limiter.run(async () => 'queued');
    await expect(limiter.run(async () => 'overflow')).rejects.toMatchObject({ code: 'gateway_busy', status: 503 });
    await expect(queued).rejects.toMatchObject({ code: 'gateway_busy', status: 503 });
    release?.();
    await expect(active).resolves.toBe('active');
  });
});

describe('WindowCostLimiter', () => {
  it('enforces weighted actor budgets and resets only after the window', () => {
    const limiter = new WindowCostLimiter(5, 1000);
    limiter.consume('alice', 3, 100);
    limiter.consume('alice', 2, 101);
    expect(() => limiter.consume('alice', 1, 102)).toThrow('method cost');
    expect(() => limiter.consume('alice', 5, 1100)).not.toThrow();
    expect(() => limiter.consume('alice', 6, 2100)).toThrow('method cost');
  });
});
