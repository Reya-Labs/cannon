import * as viem from 'viem';
import * as keys from '../db/keys';
import { transformFunction } from '../db/transformers';
import { warnMalformedDocument } from '../logging';
import { useRedis } from '../redis';
import { ApiSelectorResult, RedisFunction } from '../types';

type SelectorRedis = {
  ft: {
    search: (index: string, query: string, options: unknown) => Promise<unknown>;
  };
};

export function createSelectorQueryExecutor(
  getRedis: () => Promise<SelectorRedis> = async () => (await useRedis()) as unknown as SelectorRedis
) {
  return async function querySelectors(params: { query: string; limit?: number; chainIds?: number[] }) {
    const redis = await getRedis();
    const query = params.chainIds?.length ? `${params.query},@chainId:{${params.chainIds.join('|')}}` : params.query;

    const results = (await redis.ft.search(keys.RKEY_ABI_SEARCHABLE, query, {
      SORTBY: { BY: 'timestamp', DIRECTION: 'ASC' },
      LIMIT: { from: 0, size: params.limit ?? 20 },
      TIMEOUT: 1_000,
    })) as {
      total: number;
      documents: { value: RedisFunction }[];
    };

    const data: ApiSelectorResult[] = [];

    for (const { value } of results.documents) {
      const parsed = transformFunction(value);

      if (!parsed) {
        warnMalformedDocument('selector');
        continue;
      }
      if (params.chainIds?.length && (parsed.chainId === undefined || !params.chainIds.includes(parsed.chainId))) {
        continue;
      }

      data.push(parsed);
    }

    return {
      total: data.length,
      data,
    } satisfies {
      total: number;
      data: ApiSelectorResult[];
    };
  };
}

const querySelectors = createSelectorQueryExecutor();

export async function findSelector(params: {
  selector: viem.Hex;
  type?: 'function' | 'error';
  types?: ('function' | 'error')[];
  limit: number;
  chainIds?: number[];
}) {
  let query = `@selector:{${params.selector}}`;
  const types = params.type ? [params.type] : params.types;
  if (types?.length) {
    query += `,@type:{${types.join('|')}}`;
  }
  return querySelectors({ query, limit: params.limit, chainIds: params.chainIds });
}

export async function searchFunctions(params: {
  query: string;
  limit: number;
  chainIds?: number[];
  types?: ('function' | 'error')[];
}) {
  const typeQuery = params.types?.length ? `,@type:{${params.types.join('|')}}` : '';
  return querySelectors({
    query: `(@name:'${params.query}' | @name:${params.query}* | @name:*${params.query}*)${typeQuery}`,
    limit: params.limit,
    chainIds: params.chainIds,
  });
}
