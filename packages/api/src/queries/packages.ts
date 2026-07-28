import { PackageReference } from '@usecannon/builder';
import { distance } from 'fastest-levenshtein';
import { AggregateGroupByReducers, AggregateSteps, type RedisClientType } from 'redis';
import * as keys from '../db/keys';
import { findPackageByTag, transformPackage, transformPackageWithTag } from '../db/transformers';
import { NotFoundError, ServerError } from '../errors';
import { isRedisTagOfPackage, parsePackageName, parseTextQuery } from '../helpers';
import { warnMalformedDocument } from '../logging';
import { useRedis } from '../redis';
import { ApiDocument, ApiNamespace, ApiPackage, RedisDocument, RedisPackage, RedisTag } from '../types';
import { getChainIds, MAX_CHAIN_RESULTS } from './chains';

const DEFAULT_LIMIT = 500;
export const MAX_NAMESPACE_RESULTS = 100;

function parseNamespaceCount(value: unknown): number | undefined {
  const normalized =
    typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9][0-9]*$/.test(normalized)) return undefined;

  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function createPackageQueryExecutor(getRedis: () => Promise<RedisClientType> = useRedis) {
  return async function queryPackages(params: {
    query: string;
    limit?: number;
    includeNamespaces?: boolean;
    includePackages?: boolean;
  }) {
    const redis = await getRedis();
    const batch = redis.multi();
    const namespaceLimit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_NAMESPACE_RESULTS);

    if (params.includePackages !== false) {
      batch.ft.search(keys.RKEY_PACKAGE_SEARCHABLE, params.query, {
        SORTBY: { BY: 'timestamp', DIRECTION: 'DESC' },
        LIMIT: { from: 0, size: params.limit || DEFAULT_LIMIT },
        TIMEOUT: 1_000,
      });
    }

    if (params.includeNamespaces) {
      batch.ft.aggregate(keys.RKEY_PACKAGE_SEARCHABLE, params.query, {
        STEPS: [
          {
            type: AggregateSteps.GROUPBY,
            properties: '@name',
            REDUCE: {
              type: AggregateGroupByReducers.COUNT,
              AS: 'count',
            },
          },
          {
            type: AggregateSteps.LIMIT,
            from: 0,
            size: namespaceLimit,
          },
        ],
        TIMEOUT: 1_000,
      });
    }

    const results = (await batch.exec()) as any[];
    let resultIndex = 0;
    const packagesResults = params.includePackages !== false ? results[resultIndex++] : undefined;
    const namespacesResults = params.includeNamespaces ? results[resultIndex] : undefined;

    const data: ApiDocument[] = [];

    if (params.includePackages !== false && !packagesResults) {
      throw new ServerError('Could not connect to packages');
    }

    if (namespacesResults) {
      const namespaceDocuments = Array.isArray(namespacesResults.results)
        ? namespacesResults.results.slice(0, namespaceLimit)
        : [];
      for (const namespace of namespaceDocuments) {
        if (!namespace.name) continue;
        const count = parseNamespaceCount(namespace.count);
        if (count === undefined) {
          warnMalformedDocument('namespace');
          continue;
        }

        data.push({
          type: 'namespace',
          name: namespace.name,
          count,
        } satisfies ApiNamespace);
      }
    }

    for (const { value } of packagesResults?.documents ?? []) {
      const item = value as unknown as RedisDocument;

      if (item.type === 'package') {
        const pkg = transformPackage(item);
        if (!pkg) {
          warnMalformedDocument('package');
          continue;
        }
        data.push(pkg);
      } else if (item.type === 'tag') {
        const pkg = findPackageByTag(packagesResults.documents as any, item);

        if (!pkg) {
          warnMalformedDocument('tag');
          continue;
        }

        const taggedPackage = transformPackageWithTag(pkg, item);
        if (!taggedPackage) {
          warnMalformedDocument('tag');
          continue;
        }
        data.push(taggedPackage);
      }
    }

    return {
      total: data.length,
      data,
    } satisfies {
      total: number;
      data: ApiDocument[];
    };
  };
}

const queryPackages = createPackageQueryExecutor();

export async function findPackagesByName(params: { packageName: string; chainIds?: number[] }) {
  const packageName = parsePackageName(params.packageName);
  const queries = [`@exactName:{${packageName}}`];
  if (params.chainIds?.length) queries.push(`@chainId:{${params.chainIds.join('|')}}`);
  const results = await queryPackages({ query: queries.join(',') });

  if (!results.total) {
    throw new NotFoundError(`Package "${packageName}" not found`);
  }

  return results;
}

export async function findPackageByFullRef(params: { fullPackageRef: string; chainId: string }) {
  const redis = await useRedis();

  const ref = new PackageReference(params.fullPackageRef);

  const queryKey = `${keys.RKEY_PACKAGE_SEARCHABLE}:${ref.fullPackageRef}#${params.chainId}`;
  const tagDoc = (await redis.hGetAll(queryKey)) as unknown as RedisPackage | RedisTag;

  if (!tagDoc?.name) return null;

  if (tagDoc.type === 'package') {
    const pkg = transformPackage(tagDoc);
    if (!pkg) warnMalformedDocument('package');
    return pkg ?? null;
  }

  if (tagDoc.type !== 'tag') {
    throw new Error(`Invalid data found when looking at "${queryKey}"`);
  }

  let packageRef: PackageReference;
  try {
    packageRef = PackageReference.from(tagDoc.name, tagDoc.versionOfTag, tagDoc.preset);
  } catch {
    warnMalformedDocument('tag');
    return null;
  }
  const packageDoc = (await redis.hGetAll(
    `${keys.RKEY_PACKAGE_SEARCHABLE}:${packageRef.fullPackageRef}#${tagDoc.chainId}`
  )) as unknown as RedisPackage;

  if (!packageDoc?.name) return null;

  const pkg = transformPackageWithTag(packageDoc, tagDoc);
  if (!pkg) warnMalformedDocument('tag');
  return pkg ?? null;
}

export function createPartialPackageRefQuery(
  getRedis: () => Promise<RedisClientType> = useRedis,
  getIndexedChainIds: () => Promise<number[]> = getChainIds
) {
  return async function queryPartialPackageRef(params: { packageRef: string; chainIds?: number[] }) {
    const redis = await getRedis();
    const indexedChainIds = (await getIndexedChainIds()).slice(0, MAX_CHAIN_RESULTS);
    const requestedChainIds = params.chainIds?.length ? new Set(params.chainIds) : undefined;
    const chainIds = requestedChainIds
      ? indexedChainIds.filter((chainId) => requestedChainIds.has(chainId))
      : indexedChainIds;

    const ref = new PackageReference(params.packageRef);

    const batch = redis.multi();

    for (const chainId of chainIds) {
      batch.hGetAll(`${keys.RKEY_PACKAGE_SEARCHABLE}:${ref.fullPackageRef}#${chainId}`);
    }

    const results: (RedisPackage | RedisTag)[] = ((await batch.exec()) as any)
      .filter((doc: any) => !!doc?.name)
      .slice(0, MAX_CHAIN_RESULTS);

    const tags = results.filter((doc) => doc.type === 'tag').slice(0, MAX_CHAIN_RESULTS) as RedisTag[];
    const tagsBatch = redis.multi();
    for (const tag of tags) {
      let fullPackageRef: string;
      try {
        fullPackageRef = PackageReference.from(tag.name, tag.versionOfTag, tag.preset).fullPackageRef;
      } catch {
        warnMalformedDocument('tag');
        continue;
      }
      tagsBatch.hGetAll(`${keys.RKEY_PACKAGE_SEARCHABLE}:${fullPackageRef}#${tag.chainId}`);
    }

    const tagsResults: RedisPackage[] = ((await tagsBatch.exec()) as any).filter((doc: any) => !!doc?.name);

    const data: ApiPackage[] = [];
    for (const doc of results) {
      if (doc.type === 'tag') {
        const pkg = tagsResults.find((pkg) => isRedisTagOfPackage(pkg, doc));
        if (!pkg) continue;

        const transformed = transformPackage(pkg);
        if (!transformed) {
          warnMalformedDocument('package');
          continue;
        }

        data.push(transformed);
        continue;
      }

      const transformed = transformPackage(doc);
      if (!transformed) {
        warnMalformedDocument('package');
        continue;
      }

      data.push(transformed);
    }

    return {
      total: data.length,
      data,
    } satisfies {
      total: number;
      data: ApiPackage[];
    };
  };
}

const queryPartialPackageRef = createPartialPackageRefQuery();

export async function findPackagesByPartialRef(params: { packageRef: string; chainIds?: number[] }) {
  return queryPartialPackageRef(params);
}

export async function searchPackages(params: {
  query: any;
  limit?: number;
  chainIds?: number[];
  includeNamespaces: boolean;
  includePackages: boolean;
}) {
  const q = parseTextQuery(params.query);

  const queries: string[] = [];

  if (q) {
    const words = q.split('-');
    queries.push(`(${[...words.map((w) => `@name:*${w}*`), ...words.map((w) => `@name:%${w}%`)].join(' | ')})`);
  }

  if (params.chainIds?.length) queries.push(`@chainId:{${params.chainIds.join('|')}}`);

  const result = await queryPackages({
    query: queries.join(',') || '*',
    limit: params.limit,
    includeNamespaces: params.includeNamespaces,
    includePackages: params.includePackages,
  });

  // Sort results by showing first the more close ones to the expected one
  if (q) {
    result.data = result.data.sort((a, b) => {
      return distance(a.name, q) - distance(b.name, q);
    });
  }

  return result;
}
