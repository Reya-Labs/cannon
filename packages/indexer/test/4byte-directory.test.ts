import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as viem from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { FourByteConfig } from '../src/4byte-config';
import { FourByteRedis, parseDirectoryPage, resolvePageUrl, runFourByteEnrichment, scanFeed } from '../src/4byte-directory';

type Operation = () => void;

class MemoryRedis implements FourByteRedis {
  readonly hashes = new Map<string, Map<string, string>>();
  readonly values = new Map<string, string>();
  private executions = 0;

  constructor(private readonly afterExec: (execution: number) => void = () => undefined) {}

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  multi() {
    const operations: Operation[] = [];
    const batch = {
      exec: async () => {
        operations.forEach((operation) => operation());
        this.executions++;
        this.afterExec(this.executions);
        return [];
      },
      hSetNX: (key: string, field: string, value: string) => {
        operations.push(() => {
          const hash = this.hashes.get(key) ?? new Map<string, string>();
          if (!hash.has(field)) hash.set(field, value);
          this.hashes.set(key, hash);
        });
        return batch;
      },
      set: (key: string, value: string) => {
        operations.push(() => this.values.set(key, value));
        return batch;
      },
    };
    return batch;
  }
}

function config(overrides: Partial<FourByteConfig> = {}): FourByteConfig {
  return {
    baseUrl: 'https://www.4byte.directory',
    enabled: true,
    maxEntriesPerRun: 100,
    maxPagesPerFeed: 5,
    maxResponseBytes: 100_000,
    maxResultsPerPage: 10,
    redisUrl: 'redis://localhost:6379',
    requestTimeoutMs: 1_000,
    retries: 0,
    retryBaseMs: 5,
    retryMaxMs: 100,
    ...overrides,
  };
}

function entry(kind: 'function' | 'event', id: number) {
  const textSignature = kind === 'function' ? `transfer${id}(address,uint256)` : `Transfer${id}(address,address,uint256)`;
  const digest = viem.keccak256(viem.toBytes(textSignature));
  return {
    bytes_signature: '',
    created_at: '2026-07-26T12:00:00.000Z',
    hex_signature: kind === 'function' ? digest.slice(0, 10) : digest,
    id,
    text_signature: textSignature,
  };
}

function page(kind: 'function' | 'event', id: number, next: string | null = null) {
  return {
    count: 1,
    next,
    previous: null,
    results: [entry(kind, id)],
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

describe('4byte response validation', () => {
  it('accepts relative and absolute pagination only on the configured HTTPS origin', () => {
    expect(resolvePageUrl('/api/v1/signatures/?page=2', config().baseUrl)).toBe(
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );
    expect(resolvePageUrl('https://www.4byte.directory/api/v1/signatures/?page=2', config().baseUrl)).toBe(
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );

    expect(resolvePageUrl('http://www.4byte.directory/api/v1/signatures/?page=2', config().baseUrl)).toBe(
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );

    for (const url of [
      'https://attacker.example/api/v1/signatures/?page=2',
      'https://user:secret@www.4byte.directory/api/v1/signatures/?page=2',
      'https://www.4byte.directory/api/v1/signatures/#fragment',
    ]) {
      expect(() => resolvePageUrl(url, config().baseUrl)).toThrow('configured HTTPS origin');
    }
  });

  it('rejects malformed schema, oversized pages and selector mismatches', () => {
    expect(() =>
      parseDirectoryPage({ ...page('function', 1), results: 'invalid' }, 'function', config().baseUrl, 10)
    ).toThrow('results must be an array');
    expect(() => parseDirectoryPage(page('function', 1), 'function', config().baseUrl, 0)).toThrow('result bound');
    expect(() =>
      parseDirectoryPage(
        {
          ...page('function', 1),
          results: [{ ...entry('function', 1), hex_signature: '0x00000000' }],
        },
        'function',
        config().baseUrl,
        10
      )
    ).toThrow('does not match');
  });

  it('rejects cross-origin pagination before the page is committed', () => {
    expect(() =>
      parseDirectoryPage(
        page('event', 1, 'https://attacker.example/next'),
        'event',
        config().baseUrl,
        config().maxResultsPerPage
      )
    ).toThrow('configured HTTPS origin');
  });

  it('rejects cyclic pagination within a run', async () => {
    const repeatedUrl = 'https://www.4byte.directory/api/v1/signatures/?format=json';
    await expect(
      scanFeed(
        new MemoryRedis(),
        'function',
        config(),
        100,
        vi.fn().mockResolvedValue(jsonResponse(page('function', 1, repeatedUrl)))
      )
    ).rejects.toThrow('pagination contains a cycle');
  });
});

describe('one-shot enrichment worker', () => {
  it('commits bounded pages and cursors under the enrichment namespace', async () => {
    const redis = new MemoryRedis();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page('function', 1, '/api/v1/signatures/?page=2')))
      .mockResolvedValueOnce(jsonResponse(page('function', 2)));

    const result = await scanFeed(redis, 'function', config(), 100, fetchPage);

    expect(result).toEqual({ entries: 2, kind: 'function', pages: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    expect([...redis.hashes.keys()]).toEqual(['enrichment:4byte:abi:function:1', 'enrichment:4byte:abi:function:2']);
    expect(redis.values.get('enrichment:4byte:cursor:function')).toBe('');
  });

  it('honors the page and aggregate entry bounds', async () => {
    const redis = new MemoryRedis();
    const fetchPage = vi.fn().mockResolvedValueOnce(jsonResponse(page('function', 1, '/api/v1/signatures/?page=2')));

    const result = await scanFeed(redis, 'function', config({ maxPagesPerFeed: 1 }), 100, fetchPage);
    expect(result.pages).toBe(1);
    expect(redis.values.get('enrichment:4byte:cursor:function')).toContain('page=2');

    await expect(
      scanFeed(new MemoryRedis(), 'function', config(), 0, vi.fn().mockResolvedValue(jsonResponse(page('function', 1))))
    ).rejects.toThrow('aggregate entry bound');
  });

  it('rejects redirects and oversized response bodies', async () => {
    await expect(
      scanFeed(
        new MemoryRedis(),
        'function',
        config(),
        100,
        vi.fn().mockResolvedValue(
          new Response(null, {
            headers: { location: 'https://attacker.example' },
            status: 302,
          })
        )
      )
    ).rejects.toThrow('redirects are forbidden');

    await expect(
      scanFeed(
        new MemoryRedis(),
        'function',
        config({ maxResponseBytes: 1_024 }),
        100,
        vi.fn().mockResolvedValue(
          jsonResponse(page('function', 1), 200, {
            'content-length': '2048',
          })
        )
      )
    ).rejects.toThrow('Content-Length');
  });

  it('retries transient failures with bounded exponential backoff', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(jsonResponse(page('function', 1)));
    const wait = vi.fn().mockResolvedValue(undefined);

    await scanFeed(new MemoryRedis(), 'function', config({ retries: 2, retryBaseMs: 7 }), 100, fetchPage, wait);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[7], [14]]);
  });

  it('caps retry delays', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(page('function', 1)));
    const wait = vi.fn().mockResolvedValue(undefined);

    await scanFeed(
      new MemoryRedis(),
      'function',
      config({ retries: 2, retryBaseMs: 7, retryMaxMs: 10 }),
      100,
      fetchPage,
      wait
    );

    expect(wait.mock.calls).toEqual([[7], [10]]);
  });

  it('continues the other enrichment feed after one feed fails', async () => {
    const fetchPage = vi.fn(async (url: string | URL) => {
      if (url.toString().includes('/signatures/')) return jsonResponse({}, 503);
      return jsonResponse(page('event', 2));
    });

    const summary = await runFourByteEnrichment(new MemoryRedis(), config(), fetchPage);

    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].kind).toBe('function');
    expect(summary.feeds).toEqual([{ entries: 1, kind: 'event', pages: 1 }]);
  });

  it('counts committed pages against the aggregate budget after a later page fails', async () => {
    const redis = new MemoryRedis();
    const functionNext = '/api/v1/signatures/?page=2';
    const eventPage = {
      ...page('event', 2),
      count: 2,
      results: [entry('event', 2), entry('event', 3)],
    };
    const fetchPage = vi.fn(async (url: string | URL) => {
      const value = url.toString();
      if (value.includes('/event-signatures/')) return jsonResponse(eventPage);
      if (value.includes('page=2')) return jsonResponse({}, 400);
      return jsonResponse(page('function', 1, functionNext));
    });

    const summary = await runFourByteEnrichment(redis, config({ maxEntriesPerRun: 2 }), fetchPage);

    expect(summary.failures.map(({ kind }) => kind)).toEqual(['function', 'event']);
    expect([...redis.hashes.keys()]).toEqual(['enrichment:4byte:abi:function:1']);
  });

  it('reserves an ambiguously committed page before a lost Redis reply', async () => {
    const redis = new MemoryRedis((execution) => {
      if (execution === 1) throw new Error('connection lost after commit');
    });
    const eventPage = {
      ...page('event', 2),
      count: 2,
      results: [entry('event', 2), entry('event', 3)],
    };
    const fetchPage = vi.fn(async (url: string | URL) =>
      url.toString().includes('/event-signatures/') ? jsonResponse(eventPage) : jsonResponse(page('function', 1))
    );

    const summary = await runFourByteEnrichment(redis, config({ maxEntriesPerRun: 2 }), fetchPage);

    expect(summary.failures.map(({ kind }) => kind)).toEqual(['function', 'event']);
    expect([...redis.hashes.keys()]).toEqual(['enrichment:4byte:abi:function:1']);
  });

  it('keeps the canonical registry entrypoint free of enrichment imports', async () => {
    const indexPath = resolve(__dirname, '../src/index.ts');
    const indexSource = await readFile(indexPath, 'utf8');

    expect(indexSource).toContain("from './registry'");
    expect(indexSource).not.toContain('4byte-directory');
  });
});
