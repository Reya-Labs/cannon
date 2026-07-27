/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import * as viem from 'viem';
import { FourByteConfig } from '../src/4byte-config';
import {
  FourByteRedis,
  loop,
  parseDirectoryPage,
  resolvePageUrl,
  runFourByteEnrichment,
  scanFeed,
} from '../src/4byte-directory';

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

type FetchCall = [input: string | URL, init?: Parameters<typeof fetch>[1]];

function fetchSequence(...steps: Array<Response | Error>) {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchPage = async (...args: FetchCall): Promise<Response> => {
    calls.push(args);
    const step = steps[index++];
    if (!step) throw new Error('Unexpected fetch call');
    if (step instanceof Error) throw step;
    return step;
  };
  return { calls, fetchPage };
}

function localImportGraph(entrypoint: string): Set<string> {
  const visited = new Set<string>();
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

    for (const statement of source.statements) {
      const moduleSpecifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
      if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier) || !moduleSpecifier.text.startsWith('.')) continue;

      const target = resolve(dirname(file), moduleSpecifier.text);
      const resolved = [`${target}.ts`, resolve(target, 'index.ts')].find(existsSync);
      if (resolved) visit(resolved);
    }
  };

  visit(entrypoint);
  return visited;
}

describe('4byte response validation', () => {
  it('accepts relative and absolute pagination only on the configured HTTPS origin', () => {
    assert.equal(
      resolvePageUrl('/api/v1/signatures/?page=2', config().baseUrl),
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );
    assert.equal(
      resolvePageUrl('https://www.4byte.directory/api/v1/signatures/?page=2', config().baseUrl),
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );

    assert.equal(
      resolvePageUrl('http://www.4byte.directory/api/v1/signatures/?page=2', config().baseUrl),
      'https://www.4byte.directory/api/v1/signatures/?page=2'
    );

    for (const url of [
      'https://attacker.example/api/v1/signatures/?page=2',
      'https://user:secret@www.4byte.directory/api/v1/signatures/?page=2',
      'https://www.4byte.directory/api/v1/signatures/#fragment',
    ]) {
      assert.throws(() => resolvePageUrl(url, config().baseUrl), /configured HTTPS origin/);
    }
  });

  it('rejects malformed schema, oversized pages and selector mismatches', () => {
    assert.throws(
      () => parseDirectoryPage({ ...page('function', 1), results: 'invalid' }, 'function', config().baseUrl, 10),
      /results must be an array/
    );
    assert.throws(() => parseDirectoryPage(page('function', 1), 'function', config().baseUrl, 0), /result bound/);
    assert.throws(
      () =>
        parseDirectoryPage(
          {
            ...page('function', 1),
            results: [{ ...entry('function', 1), hex_signature: '0x00000000' }],
          },
          'function',
          config().baseUrl,
          10
        ),
      /does not match/
    );
  });

  it('rejects cross-origin pagination before the page is committed', () => {
    assert.throws(
      () =>
        parseDirectoryPage(
          page('event', 1, 'https://attacker.example/next'),
          'event',
          config().baseUrl,
          config().maxResultsPerPage
        ),
      /configured HTTPS origin/
    );
  });

  it('rejects cyclic pagination within a run', async () => {
    const repeatedUrl = 'https://www.4byte.directory/api/v1/signatures/?format=json';
    const { fetchPage } = fetchSequence(jsonResponse(page('function', 1, repeatedUrl)));
    await assert.rejects(scanFeed(new MemoryRedis(), 'function', config(), 100, fetchPage), /pagination contains a cycle/);
  });
});

describe('one-shot enrichment worker', () => {
  it('returns while disabled without opening Redis or making a request', async () => {
    let redisCalls = 0;
    let fetchCalls = 0;

    await loop(
      {},
      {
        fetchPage: async () => {
          fetchCalls++;
          throw new Error('network must not be reached');
        },
        log: () => undefined,
        useRedis: async () => {
          redisCalls++;
          throw new Error('Redis must not be reached');
        },
      }
    );

    assert.equal(redisCalls, 0);
    assert.equal(fetchCalls, 0);
  });

  it('commits bounded pages and cursors under the enrichment namespace', async () => {
    const redis = new MemoryRedis();
    const { calls, fetchPage } = fetchSequence(
      jsonResponse(page('function', 1, '/api/v1/signatures/?page=2')),
      jsonResponse(page('function', 2))
    );

    const result = await scanFeed(redis, 'function', config(), 100, fetchPage);

    assert.deepEqual(result, { entries: 2, kind: 'function', pages: 2 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1]?.redirect, 'manual');
    assert.deepEqual([...redis.hashes.keys()], ['enrichment:4byte:abi:function:1', 'enrichment:4byte:abi:function:2']);
    assert.deepEqual(Object.fromEntries(redis.hashes.get('enrichment:4byte:abi:function:1') ?? []), {
      name: 'transfer1(address,uint256)',
      selector: entry('function', 1).hex_signature,
      source: '4byte.directory',
      timestamp: '1785067200',
      trust: 'unverified',
      type: 'function',
    });
    assert.equal(redis.values.get('enrichment:4byte:cursor:function'), '');
  });

  it('honors the page and aggregate entry bounds', async () => {
    const redis = new MemoryRedis();
    const { fetchPage } = fetchSequence(jsonResponse(page('function', 1, '/api/v1/signatures/?page=2')));

    const result = await scanFeed(redis, 'function', config({ maxPagesPerFeed: 1 }), 100, fetchPage);
    assert.equal(result.pages, 1);
    assert.match(redis.values.get('enrichment:4byte:cursor:function') ?? '', /page=2/);

    const boundedFetch = fetchSequence(jsonResponse(page('function', 1))).fetchPage;
    await assert.rejects(scanFeed(new MemoryRedis(), 'function', config(), 0, boundedFetch), /aggregate entry bound/);
  });

  it('rejects redirects and oversized response bodies', async () => {
    let redirectBodyCancelled = false;
    const redirectFetch = fetchSequence(
      new Response(
        new ReadableStream({
          cancel() {
            redirectBodyCancelled = true;
          },
        }),
        {
          headers: { location: 'https://attacker.example' },
          status: 302,
        }
      )
    ).fetchPage;
    await assert.rejects(scanFeed(new MemoryRedis(), 'function', config(), 100, redirectFetch), /redirects are forbidden/);
    assert.equal(redirectBodyCancelled, true);

    const oversizedFetch = fetchSequence(
      jsonResponse(page('function', 1), 200, {
        'content-length': '2048',
      })
    ).fetchPage;
    await assert.rejects(
      scanFeed(new MemoryRedis(), 'function', config({ maxResponseBytes: 1_024 }), 100, oversizedFetch),
      /Content-Length/
    );
  });

  it('retries body-stream failures but not invalid JSON', async () => {
    let pulls = 0;
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          return;
        }
        throw new Error('socket reset');
      },
    });
    const retrying = fetchSequence(
      new Response(failingBody, { headers: { 'content-type': 'application/json' } }),
      jsonResponse(page('function', 1))
    );
    const delays: number[] = [];

    const result = await scanFeed(
      new MemoryRedis(),
      'function',
      config({ retries: 1 }),
      100,
      retrying.fetchPage,
      async (milliseconds) => {
        delays.push(milliseconds);
      }
    );

    assert.equal(result.entries, 1);
    assert.equal(retrying.calls.length, 2);
    assert.deepEqual(delays, [5]);

    const invalidJson = fetchSequence(
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      jsonResponse(page('function', 2))
    );
    await assert.rejects(
      scanFeed(new MemoryRedis(), 'function', config({ retries: 1 }), 100, invalidJson.fetchPage),
      /not valid JSON/
    );
    assert.equal(invalidJson.calls.length, 1);
  });

  it('retries transient failures with bounded exponential backoff', async () => {
    const { calls, fetchPage } = fetchSequence(
      jsonResponse({}, 503),
      new Error('network unavailable'),
      jsonResponse(page('function', 1))
    );
    const delays: number[] = [];
    const wait = async (milliseconds: number) => {
      delays.push(milliseconds);
    };

    await scanFeed(new MemoryRedis(), 'function', config({ retries: 2, retryBaseMs: 7 }), 100, fetchPage, wait);

    assert.equal(calls.length, 3);
    assert.deepEqual(delays, [7, 14]);
  });

  it('caps retry delays', async () => {
    const { fetchPage } = fetchSequence(jsonResponse({}, 503), jsonResponse({}, 503), jsonResponse(page('function', 1)));
    const delays: number[] = [];
    const wait = async (milliseconds: number) => {
      delays.push(milliseconds);
    };

    await scanFeed(
      new MemoryRedis(),
      'function',
      config({ retries: 2, retryBaseMs: 7, retryMaxMs: 10 }),
      100,
      fetchPage,
      wait
    );

    assert.deepEqual(delays, [7, 10]);
  });

  it('continues the other enrichment feed after one feed fails', async () => {
    const fetchPage = async (url: string | URL) => {
      if (url.toString().includes('/signatures/')) return jsonResponse({}, 503);
      return jsonResponse(page('event', 2));
    };

    const summary = await runFourByteEnrichment(new MemoryRedis(), config(), fetchPage);

    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].kind, 'function');
    assert.deepEqual(summary.feeds, [{ entries: 1, kind: 'event', pages: 1 }]);
  });

  it('counts committed pages against the aggregate budget after a later page fails', async () => {
    const redis = new MemoryRedis();
    const functionNext = '/api/v1/signatures/?page=2';
    const eventPage = {
      ...page('event', 2),
      count: 2,
      results: [entry('event', 2), entry('event', 3)],
    };
    const fetchPage = async (url: string | URL) => {
      const value = url.toString();
      if (value.includes('/event-signatures/')) return jsonResponse(eventPage);
      if (value.includes('page=2')) return jsonResponse({}, 400);
      return jsonResponse(page('function', 1, functionNext));
    };

    const summary = await runFourByteEnrichment(redis, config({ maxEntriesPerRun: 2 }), fetchPage);

    assert.deepEqual(
      summary.failures.map(({ kind }) => kind),
      ['function', 'event']
    );
    assert.deepEqual([...redis.hashes.keys()], ['enrichment:4byte:abi:function:1']);
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
    const fetchPage = async (url: string | URL) =>
      url.toString().includes('/event-signatures/') ? jsonResponse(eventPage) : jsonResponse(page('function', 1));

    const summary = await runFourByteEnrichment(redis, config({ maxEntriesPerRun: 2 }), fetchPage);

    assert.deepEqual(
      summary.failures.map(({ kind }) => kind),
      ['function', 'event']
    );
    assert.deepEqual([...redis.hashes.keys()], ['enrichment:4byte:abi:function:1']);
  });

  it('keeps the canonical registry import graph free of enrichment modules', () => {
    const indexPath = resolve(__dirname, '../src/index.ts');
    const imports = localImportGraph(indexPath);
    const registryImports = localImportGraph(resolve(__dirname, '../src/registry.ts'));

    assert.ok(imports.has(resolve(__dirname, '../src/process-mode.ts')));
    assert.ok(!imports.has(resolve(__dirname, '../src/4byte-directory.ts')));
    assert.ok(!imports.has(resolve(__dirname, '../src/4byte-config.ts')));
    assert.ok(registryImports.has(resolve(__dirname, '../src/queue/contracts.ts')));
    assert.ok(!registryImports.has(resolve(__dirname, '../src/queue/pinning.ts')));
    assert.ok(!registryImports.has(resolve(__dirname, '../src/worker.ts')));
    assert.ok(!registryImports.has(resolve(__dirname, '../src/4byte-directory.ts')));
    assert.ok(!registryImports.has(resolve(__dirname, '../src/4byte-config.ts')));
  });
});
