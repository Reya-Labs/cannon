/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AggregateSteps, type RedisClientType } from 'redis';
import { createChainQueries, MAX_CHAIN_RESULTS } from '../src/queries/chains';
import { createPackageQueryExecutor, createPartialPackageRefQuery, MAX_NAMESPACE_RESULTS } from '../src/queries/packages';

describe('bounded aggregate query factories', () => {
  it('limits and validates chain aggregates while reusing the cached query promise', async () => {
    let aggregateCalls = 0;
    let aggregateOptions: { STEPS?: { from?: number; size?: number; type?: string }[] } | undefined;
    const redis = {
      ft: {
        aggregate: async (_index: string, _query: string, options: unknown) => {
          aggregateCalls += 1;
          aggregateOptions = options as typeof aggregateOptions;
          return {
            total: '999',
            results: [
              ...Array.from({ length: MAX_CHAIN_RESULTS + 10 }, (_, index) => ({ chainId: String(index + 1) })),
              { chainId: '1' },
              { chainId: '0' },
              { chainId: '-1' },
              { chainId: '1|@name:*' },
              { chainId: String(Number.MAX_SAFE_INTEGER + 1) },
              { chainId: null },
            ],
          };
        },
      },
    };
    const queries = createChainQueries(async () => redis);

    const [first, second] = await Promise.all([queries.getChainIdsWithCount(), queries.getChainIdsWithCount()]);

    assert.equal(aggregateCalls, 1);
    assert.deepEqual(first, second);
    assert.equal(first.total, 999);
    assert.equal(first.data.length, MAX_CHAIN_RESULTS);
    assert.deepEqual(
      first.data,
      Array.from({ length: MAX_CHAIN_RESULTS }, (_, index) => index + 1)
    );

    const limit = aggregateOptions?.STEPS?.find((step) => step.type === AggregateSteps.LIMIT);
    assert.deepEqual(limit, { type: AggregateSteps.LIMIT, from: 0, size: MAX_CHAIN_RESULTS });

    assert.deepEqual(await queries.getChainIdsWithCount(), first);
    assert.equal(aggregateCalls, 1);
  });

  it('limits namespace aggregation in Redis and defensively caps returned groups', async () => {
    let aggregateOptions: { STEPS?: { from?: number; size?: number; type?: string }[] } | undefined;
    const batch = {
      exec: async () => [
        { documents: [], total: 0 },
        {
          results: Array.from({ length: MAX_NAMESPACE_RESULTS + 20 }, (_, index) => ({
            count: index + 1,
            name: `namespace-${index}`,
          })),
          total: MAX_NAMESPACE_RESULTS + 20,
        },
      ],
      ft: {
        aggregate: (_index: string, _query: string, options: unknown) => {
          aggregateOptions = options as typeof aggregateOptions;
          return batch;
        },
        search: () => batch,
      },
    };
    const redis = { multi: () => batch } as unknown as RedisClientType;
    const queryPackages = createPackageQueryExecutor(async () => redis);

    const result = await queryPackages({ includeNamespaces: true, limit: 500, query: '*' });

    assert.equal(result.data.length, MAX_NAMESPACE_RESULTS);
    const limit = aggregateOptions?.STEPS?.find((step) => step.type === AggregateSteps.LIMIT);
    assert.deepEqual(limit, { type: AggregateSteps.LIMIT, from: 0, size: MAX_NAMESPACE_RESULTS });
  });

  it('evicts rejected chain query promises so a recovered Redis can be retried', async () => {
    let aggregateCalls = 0;
    const queries = createChainQueries(async () => ({
      ft: {
        aggregate: async () => {
          aggregateCalls += 1;
          if (aggregateCalls === 1) throw new Error('Redis unavailable');
          return { results: [{ chainId: '1' }], total: 1 };
        },
      },
    }));

    await assert.rejects(queries.getChainIdsWithCount(), /Redis unavailable/);
    assert.deepEqual(await queries.getChainIdsWithCount(), { data: [1], total: 1 });
    assert.equal(aggregateCalls, 2);
  });

  it('caps both chain lookups and tag-resolution fanout', async () => {
    const fanouts: number[] = [];
    let batchNumber = 0;
    const redis = {
      multi: () => {
        const keys: string[] = [];
        return {
          exec: async () => {
            fanouts.push(keys.length);
            batchNumber += 1;
            if (batchNumber > 1) return keys.map(() => ({}));
            return keys.map((_, index) => ({
              chainId: String(index + 1),
              name: 'package',
              preset: 'main',
              tag: 'latest',
              timestamp: '1',
              type: 'tag',
              versionOfTag: '1.0.0',
            }));
          },
          hGetAll: (key: string) => {
            keys.push(key);
          },
        };
      },
    } as unknown as RedisClientType;
    const queryPartialPackageRef = createPartialPackageRefQuery(
      async () => redis,
      async () => Array.from({ length: MAX_CHAIN_RESULTS + 25 }, (_, index) => index + 1)
    );

    await queryPartialPackageRef({ packageRef: 'package:latest' });

    assert.deepEqual(fanouts, [MAX_CHAIN_RESULTS, MAX_CHAIN_RESULTS]);
  });
});
