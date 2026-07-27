/* eslint-disable @typescript-eslint/no-floating-promises, no-console -- test registration and log interception are intentional. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AggregateSteps, type RedisClientType } from 'redis';
import { createChainQueries, MAX_CHAIN_RESULTS } from '../src/queries/chains';
import { createPackageQueryExecutor, createPartialPackageRefQuery, MAX_NAMESPACE_RESULTS } from '../src/queries/packages';
import { createSelectorQueryExecutor } from '../src/queries/selectors';

const DEPLOY_URL = 'ipfs://QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const META_URL = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const DEPLOY_URL_V1 = 'ipfs://bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354';

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
            count: String(index + 1),
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
    assert.equal(result.data[0]?.type, 'namespace');
    assert.equal(result.data[0]?.count, 1);
    assert.equal(typeof result.data[0]?.count, 'number');
    const limit = aggregateOptions?.STEPS?.find((step) => step.type === AggregateSteps.LIMIT);
    assert.deepEqual(limit, { type: AggregateSteps.LIMIT, from: 0, size: MAX_NAMESPACE_RESULTS });
  });

  it('skips namespace groups whose Redis COUNT cannot satisfy the numeric API contract', async () => {
    const batch = {
      exec: async () => [
        { documents: [], total: 0 },
        {
          results: [
            { count: '2', name: 'valid' },
            { count: '0', name: 'zero' },
            { count: '-1', name: 'negative' },
            { count: '1.5', name: 'fractional' },
            { count: String(Number.MAX_SAFE_INTEGER + 1), name: 'unsafe' },
            { count: Buffer.from('3'), name: 'buffer' },
          ],
          total: 6,
        },
      ],
      ft: {
        aggregate: () => batch,
        search: () => batch,
      },
    };
    const redis = { multi: () => batch } as unknown as RedisClientType;
    const warnings: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);

    try {
      const queryPackages = createPackageQueryExecutor(async () => redis);
      const result = await queryPackages({ includeNamespaces: true, query: '*' });

      assert.deepEqual(result.data, [{ count: 2, name: 'valid', type: 'namespace' }]);
      assert.deepEqual(
        warnings,
        Array.from({ length: 5 }, () => ['query API skipped malformed Redis document', { kind: 'namespace' }])
      );
    } finally {
      console.warn = originalConsoleWarn;
    }
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

  it('restricts partial package lookup fanout to requested indexed chains', async () => {
    const requestedKeys: string[] = [];
    const redis = {
      multi: () => ({
        exec: async () => [],
        hGetAll: (key: string) => requestedKeys.push(key),
      }),
    } as unknown as RedisClientType;
    const queryPartialPackageRef = createPartialPackageRefQuery(
      async () => redis,
      async () => [1, 10, 1729, 8453]
    );

    const result = await queryPartialPackageRef({
      packageRef: 'valid-package:1.2.3',
      chainIds: [1729, 999999],
    });

    assert.deepEqual(result, { data: [], total: 0 });
    assert.equal(requestedKeys.length, 1);
    assert.match(requestedKeys[0]!, /#1729$/);
  });

  it('skips malformed tags without discarding valid tag resolutions', async () => {
    let batchNumber = 0;
    const fanouts: number[] = [];
    const redis = {
      multi: () => {
        const keys: string[] = [];
        return {
          exec: async () => {
            fanouts.push(keys.length);
            batchNumber += 1;
            if (batchNumber === 1) {
              return [
                {
                  chainId: '1',
                  name: 'valid-package',
                  preset: 'main',
                  tag: 'latest',
                  timestamp: '1',
                  type: 'tag',
                  versionOfTag: '1.0.0',
                },
                {
                  chainId: '2',
                  name: '!',
                  preset: 'main',
                  tag: 'latest',
                  timestamp: '1',
                  type: 'tag',
                  versionOfTag: '1.0.0',
                },
              ];
            }
            return [
              {
                chainId: '1',
                deployUrl: DEPLOY_URL,
                metaUrl: META_URL,
                name: 'valid-package',
                owner: '0x0000000000000000000000000000000000000001',
                preset: 'main',
                timestamp: '1',
                type: 'package',
                version: '1.0.0',
              },
            ];
          },
          hGetAll: (key: string) => {
            keys.push(key);
          },
        };
      },
    } as unknown as RedisClientType;
    const warnings: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);

    try {
      const queryPartialPackageRef = createPartialPackageRefQuery(
        async () => redis,
        async () => [1, 2]
      );
      const result = await queryPartialPackageRef({ packageRef: 'valid-package:latest' });

      assert.equal(result.total, 1);
      assert.equal(result.data[0]?.name, 'valid-package');
      assert.equal(result.data[0]?.chainId, 1);
      assert.equal(result.data[0]?.publisher, '0x0000000000000000000000000000000000000001');
      assert.equal('owner' in result.data[0]!, false);
      assert.deepEqual(fanouts, [2, 1]);
      assert.deepEqual(warnings, [['query API skipped malformed Redis document', { kind: 'tag' }]]);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  it('normalizes exact-version partial matches into the public package contract', async () => {
    let batchNumber = 0;
    const redis = {
      multi: () => ({
        exec: async () => {
          batchNumber += 1;
          if (batchNumber > 1) return [];
          return [
            {
              chainId: '1729',
              deployUrl: DEPLOY_URL.replace('ipfs://', ''),
              metaUrl: '',
              name: 'valid-package',
              owner: '0x0000000000000000000000000000000000000001',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
          ];
        },
        hGetAll: () => undefined,
      }),
    } as unknown as RedisClientType;
    const queryPartialPackageRef = createPartialPackageRefQuery(
      async () => redis,
      async () => [1729]
    );

    const result = await queryPartialPackageRef({ packageRef: 'valid-package:1.2.3' });

    assert.deepEqual(result, {
      total: 1,
      data: [
        {
          type: 'package',
          name: 'valid-package',
          version: '1.2.3',
          preset: 'main',
          chainId: 1729,
          deployUrl: DEPLOY_URL,
          metaUrl: '',
          timestamp: 123,
          publisher: '0x0000000000000000000000000000000000000001',
        },
      ],
    });
    assert.equal('owner' in result.data[0]!, false);
  });

  it('skips partial matches with malformed publishers or artifact references', async () => {
    let batchNumber = 0;
    const redis = {
      multi: () => ({
        exec: async () => {
          batchNumber += 1;
          if (batchNumber > 1) return [];
          return [
            {
              chainId: '1',
              deployUrl: DEPLOY_URL,
              metaUrl: META_URL,
              name: 'valid-package',
              owner: 'not-an-address',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
            {
              chainId: '2',
              deployUrl: `ipfs://Qm${'1'.repeat(44)}`,
              metaUrl: META_URL,
              name: 'valid-package',
              owner: '0x0000000000000000000000000000000000000002',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
            {
              chainId: '3',
              deployUrl: `ipfs://Qm${'z'.repeat(44)}`,
              metaUrl: META_URL,
              name: 'valid-package',
              owner: '0x0000000000000000000000000000000000000003',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
            {
              chainId: '4',
              deployUrl: DEPLOY_URL_V1,
              metaUrl: META_URL,
              name: 'valid-package',
              owner: '0x0000000000000000000000000000000000000004',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
            {
              chainId: '5',
              deployUrl: DEPLOY_URL,
              metaUrl: META_URL,
              name: 'valid-package',
              owner: '0x0000000000000000000000000000000000000005',
              preset: 'main',
              timestamp: '123',
              type: 'package',
              version: '1.2.3',
            },
          ];
        },
        hGetAll: () => undefined,
      }),
    } as unknown as RedisClientType;
    const warnings: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);

    try {
      const queryPartialPackageRef = createPartialPackageRefQuery(
        async () => redis,
        async () => [1, 2, 3, 4, 5]
      );

      const result = await queryPartialPackageRef({ packageRef: 'valid-package:1.2.3' });

      assert.equal(result.total, 1);
      assert.equal(result.data[0]?.chainId, 5);
      assert.deepEqual(warnings, [
        ['query API skipped malformed Redis document', { kind: 'package' }],
        ['query API skipped malformed Redis document', { kind: 'package' }],
        ['query API skipped malformed Redis document', { kind: 'package' }],
        ['query API skipped malformed Redis document', { kind: 'package' }],
      ]);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });

  it('preserves selector types and skips malformed package-backed records without throwing', async () => {
    const canonical = {
      address: '0x0000000000000000000000000000000000000001',
      chainId: '1729',
      contractName: 'CoreProxy',
      name: 'Unauthorized()',
      package: 'valid-package:1.2.3@main',
      selector: '0x82b42900',
      timestamp: '123',
    };
    const redis = {
      ft: {
        search: async () => ({
          documents: [
            { value: { ...canonical, type: 'error' } },
            { value: { ...canonical, name: 'owner()', selector: '0x8da5cb5b', type: 'function' } },
            { value: { ...canonical, chainId: '1', type: 'error' } },
            {
              value: {
                name: 'Unauthorized()',
                selector: '0x82b42900',
                timestamp: '123',
                type: 'error',
              },
            },
            { value: { ...canonical, address: '', type: 'error' } },
            { value: { ...canonical, chainId: '', type: 'error' } },
            { value: { ...canonical, contractName: '', type: 'error' } },
          ],
          total: 7,
        }),
      },
    };
    const warnings: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values);

    try {
      const querySelectors = createSelectorQueryExecutor(async () => redis);
      const result = await querySelectors({
        limit: 20,
        query: '@selector:{0x82b42900}',
        chainIds: [1729],
      });

      assert.equal(result.total, 3);
      assert.deepEqual(
        result.data.map(({ type, chainId }) => [type, chainId]),
        [
          ['error', 1729],
          ['function', 1729],
          ['error', undefined],
        ]
      );
      assert.equal(
        result.data.some(({ chainId }) => Number.isNaN(chainId)),
        false
      );
      assert.deepEqual(warnings, [
        ['query API skipped malformed Redis document', { kind: 'selector' }],
        ['query API skipped malformed Redis document', { kind: 'selector' }],
        ['query API skipped malformed Redis document', { kind: 'selector' }],
      ]);
    } finally {
      console.warn = originalConsoleWarn;
    }
  });
});
