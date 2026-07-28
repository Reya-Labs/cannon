import TTLCache from '@isaacs/ttlcache';
import { AggregateGroupByReducers, AggregateSteps } from 'redis';
import * as keys from '../db/keys';
import { isChainId } from '../helpers';
import { useRedis } from '../redis';

interface ChainsResponse {
  total: number;
  data: number[];
}

export const MAX_CHAIN_RESULTS = 50;

type ChainRedis = {
  ft: {
    aggregate: (index: string, query: string, options: unknown) => Promise<unknown>;
  };
};

function parseRedisChainId(value: unknown): number | undefined {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  return isChainId(normalized) ? Number.parseInt(normalized, 10) : undefined;
}

function parseRedisTotal(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

export function createChainQueries(
  getRedis: () => Promise<ChainRedis> = async () => (await useRedis()) as unknown as ChainRedis
) {
  const cache = new TTLCache<string, Promise<ChainsResponse>>({ max: 10, ttl: 60 * 1000 });

  async function queryChains(withTotal: boolean): Promise<ChainsResponse> {
    const redis = await getRedis();

    const results = (await redis.ft.aggregate(keys.RKEY_PACKAGE_SEARCHABLE, '*', {
      STEPS: [
        {
          type: AggregateSteps.GROUPBY,
          properties: '@chainId',
          REDUCE: withTotal
            ? {
                type: AggregateGroupByReducers.COUNT,
              }
            : {
                type: AggregateGroupByReducers.COUNT_DISTINCT,
                property: '@chainId',
              },
        },
        {
          type: AggregateSteps.LIMIT,
          from: 0,
          size: MAX_CHAIN_RESULTS,
        },
      ],
      TIMEOUT: 1_000,
    })) as { results?: unknown; total?: unknown };

    const rawResults = Array.isArray(results.results) ? results.results : [];
    const data = [
      ...new Set(
        rawResults
          .map((result) =>
            typeof result === 'object' && result !== null && 'chainId' in result
              ? parseRedisChainId(result.chainId)
              : undefined
          )
          .filter((chainId): chainId is number => chainId !== undefined)
      ),
    ].slice(0, MAX_CHAIN_RESULTS);

    return {
      total: parseRedisTotal(results.total, data.length),
      data,
    };
  }

  function cachedQuery(key: string, withTotal: boolean): Promise<ChainsResponse> {
    const cached = cache.get(key);
    if (cached) return cached;

    const query = queryChains(withTotal);
    cache.set(key, query);
    void query.catch(() => cache.delete(key));
    return query;
  }

  return {
    async getChainIds(): Promise<number[]> {
      return (await cachedQuery('getChainIds', false)).data;
    },
    getChainIdsWithCount(): Promise<ChainsResponse> {
      return cachedQuery('getChainIdsWithCount', true);
    },
  };
}

const chainQueries = createChainQueries();

export async function getChainIds(): Promise<number[]> {
  return chainQueries.getChainIds();
}

export async function getChainIdsWithCount(): Promise<ChainsResponse> {
  return chainQueries.getChainIdsWithCount();
}
