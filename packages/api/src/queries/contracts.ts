import { PackageReference } from '@usecannon/builder';
import { AggregateGroupByReducers, AggregateSteps } from 'redis';
import * as viem from 'viem';
import * as keys from '../db/keys';
import { isChainId, isContractName } from '../helpers';
import { warnMalformedDocument } from '../logging';
import { useRedis } from '../redis';
import { ApiContract } from '../types';

type ContractQueryResult = { contractName: string; package: string; chainId: string; address: string };

function _parseAggregateResult(doc: ContractQueryResult) {
  if (!doc) return;
  if (!isContractName(doc.contractName)) return;
  if (!PackageReference.isValid(doc.package)) return;
  if (!isChainId(doc.chainId)) return;
  if (!viem.isAddress(doc.address)) return;
  return doc;
}

async function _aggregateContracts(query: string, limit: number): Promise<ContractQueryResult[]> {
  const redis = await useRedis();

  const data: ContractQueryResult[] = [];

  const res = (await redis.ft.aggregate(keys.RKEY_ABI_SEARCHABLE, query, {
    LOAD: { identifier: '@package' },
    STEPS: [
      {
        type: AggregateSteps.GROUPBY,
        properties: ['@contractName', '@package', '@chainId', '@address'],
        REDUCE: {
          type: AggregateGroupByReducers.FIRST_VALUE,
          property: '@contractName',
        },
      },
      {
        type: AggregateSteps.LIMIT,
        from: 0,
        size: limit,
      },
    ],
    TIMEOUT: 1_000,
  })) as {
    total: number;
    results: ContractQueryResult[];
  };

  for (const doc of res.results) {
    const parsed = _parseAggregateResult(doc);

    if (!parsed) {
      warnMalformedDocument('contract');
      continue;
    }

    data.push(parsed);
  }

  return data;
}

/**
 * Applies an optional chain constraint to a complete RediSearch contract query.
 *
 * The base query is grouped so an OR expression cannot escape the chain
 * constraint through RediSearch operator precedence.
 */
export function scopeContractQuery(query: string, chainIds?: number[]): string {
  return chainIds?.length ? `(${query}),@chainId:{${chainIds.join('|')}}` : query;
}

async function _queryContracts(params: { query: string; limit?: number; chainIds?: number[] }) {
  const results = await _aggregateContracts(scopeContractQuery(params.query, params.chainIds), params.limit ?? 20);

  const data = results.map((doc) => {
    const ref = new PackageReference(doc.package);
    return {
      type: 'contract',
      address: viem.getAddress(doc.address),
      name: doc.contractName,
      chainId: Number.parseInt(doc.chainId),
      packageName: ref.name,
      preset: ref.preset,
      version: ref.version,
    } satisfies ApiContract;
  });

  return {
    total: data.length,
    data,
  } satisfies {
    total: number;
    data: ApiContract[];
  };
}

export async function findContractsByAddress(params: { address: viem.Address; limit: number; chainIds?: number[] }) {
  const contractAddress = viem.getAddress(params.address);
  return _queryContracts({
    query: `@address:{${contractAddress}}`,
    limit: params.limit,
    chainIds: params.chainIds,
  });
}

export async function searchContracts(params: { query: string; limit: number; chainIds?: number[] }) {
  return _queryContracts({
    query: `@contractName:'${params.query}' | @contractName:${params.query}* | @contractName:*${params.query}*`,
    limit: params.limit,
    chainIds: params.chainIds,
  });
}
