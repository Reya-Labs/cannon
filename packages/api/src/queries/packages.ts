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

export function createPackageQueryExecutor(getRedis: () => Promise<RedisClientType> = useRedis) {
  return async function queryPackages(params: { query: string; limit?: number; includeNamespaces?: boolean }) {
    const redis = await getRedis();
    const batch = redis.multi();
    const namespaceLimit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_NAMESPACE_RESULTS);

    batch.ft.search(keys.RKEY_PACKAGE_SEARCHABLE, params.query, {
      SORTBY: { BY: 'timestamp', DIRECTION: 'DESC' },
      LIMIT: { from: 0, size: params.limit || DEFAULT_LIMIT },
      TIMEOUT: 1_000,
    });

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

    const [packagesResults, namespacesResults] = (await batch.exec()) as any[];

    const data: ApiDocument[] = [];

    if (!packagesResults) {
      throw new ServerError('Could not connect to packages');
    }

    if (namespacesResults) {
      const namespaceDocuments = Array.isArray(namespacesResults.results)
        ? namespacesResults.results.slice(0, namespaceLimit)
        : [];
      for (const namespace of namespaceDocuments) {
        if (!namespace.name) continue;

        data.push({
          type: 'namespace',
          name: namespace.name,
          count: namespace.count,
        } satisfies ApiNamespace);
      }
    }

    for (const { value } of packagesResults.documents) {
      const item = value as unknown as RedisDocument;

      if (item.type === 'package') {
        data.push(transformPackage(item));
      } else if (item.type === 'tag') {
        const pkg = findPackageByTag(packagesResults.documents as any, item);

        if (!pkg) {
          warnMalformedDocument('tag');
          continue;
        }

        data.push(transformPackageWithTag(pkg, item));
      }
    }

    return {
      total: packagesResults.total + (namespacesResults?.total || 0),
      data,
    } satisfies {
      total: number;
      data: ApiDocument[];
    };
  };
}

const queryPackages = createPackageQueryExecutor();

export async function findPackagesByName(params: { packageName: string }) {
  const packageName = parsePackageName(params.packageName);
  const results = await queryPackages({ query: `@exactName:{${packageName}}` });

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
    return transformPackage(tagDoc);
  }

  if (tagDoc.type !== 'tag') {
    throw new Error(`Invalid data found when looking at "${queryKey}"`);
  }

  const packageRef = PackageReference.from(tagDoc.name, tagDoc.versionOfTag, tagDoc.preset);
  const packageDoc = (await redis.hGetAll(
    `${keys.RKEY_PACKAGE_SEARCHABLE}:${packageRef.fullPackageRef}#${tagDoc.chainId}`
  )) as unknown as RedisPackage;

  if (!packageDoc?.name) return null;

  return transformPackageWithTag(packageDoc, tagDoc);
}

export function createPartialPackageRefQuery(
  getRedis: () => Promise<RedisClientType> = useRedis,
  getIndexedChainIds: () => Promise<number[]> = getChainIds
) {
  return async function queryPartialPackageRef(params: { packageRef: string }) {
    const redis = await getRedis();
    const chainIds = (await getIndexedChainIds()).slice(0, MAX_CHAIN_RESULTS);

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
      const { fullPackageRef } = PackageReference.from(tag.name, tag.versionOfTag, tag.preset);
      tagsBatch.hGetAll(`${keys.RKEY_PACKAGE_SEARCHABLE}:${fullPackageRef}#${tag.chainId}`);
    }

    const tagsResults: RedisPackage[] = ((await tagsBatch.exec()) as any).filter((doc: any) => !!doc?.name);

    const data = results
      .map((doc) => {
        if (doc.type === 'tag') {
          const pkg = tagsResults.find((pkg) => isRedisTagOfPackage(pkg, doc));
          return pkg && transformPackage(pkg);
        }

        return doc;
      })
      .filter((doc) => !!doc) as ApiPackage[];

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

export async function findPackagesByPartialRef(params: { packageRef: string }) {
  return queryPartialPackageRef(params);
}

export async function searchPackages(params: {
  query: any;
  limit?: number;
  chainIds?: number[];
  includeNamespaces: boolean;
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
  });

  // Sort results by showing first the more close ones to the expected one
  if (q) {
    result.data = result.data.sort((a, b) => {
      return distance(a.name, q) - distance(b.name, q);
    });
  }

  return result;
}
