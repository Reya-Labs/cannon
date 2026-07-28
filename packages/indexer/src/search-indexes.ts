import { RedisClientType, SchemaFieldTypes } from 'redis';
import * as rkey from './db';
/* eslint no-console: "off" */

/**
 * Creates the package, canonical ABI, and isolated 4byte RediSearch indexes.
 *
 * This mutates index metadata and adds the package exact-name field; it does
 * not delete or rewrite source hashes. Existing managed indexes cause Redis to
 * reject the corresponding create operation.
 */
export async function initializeIndexes(redis: RedisClientType) {
  console.log('[REG] create index', rkey.RKEY_PACKAGE_SEARCHABLE);
  await redis.ft.create(
    rkey.RKEY_PACKAGE_SEARCHABLE,
    {
      name: { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      type: { type: SchemaFieldTypes.TAG },
      timestamp: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
      chainId: { type: SchemaFieldTypes.TAG },
    },
    { PREFIX: rkey.RKEY_PACKAGE_SEARCHABLE + ':' }
  );

  await redis.ft.alter(rkey.RKEY_PACKAGE_SEARCHABLE, {
    name: { type: SchemaFieldTypes.TAG, AS: 'exactName' },
  });

  console.log('[REG] create index', rkey.RKEY_ABI_SEARCHABLE);
  await redis.ft.create(
    rkey.RKEY_ABI_SEARCHABLE,
    {
      name: { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      contractName: { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      type: { type: SchemaFieldTypes.TAG },
      selector: { type: SchemaFieldTypes.TAG },
      address: { type: SchemaFieldTypes.TAG },
      chainId: { type: SchemaFieldTypes.TAG },
      timestamp: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
    },
    { PREFIX: rkey.RKEY_ABI_SEARCHABLE + ':' }
  );

  console.log('[REG] create index', rkey.RKEY_4BYTE_ABI_SEARCHABLE);
  await redis.ft.create(
    rkey.RKEY_4BYTE_ABI_SEARCHABLE,
    {
      name: { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      type: { type: SchemaFieldTypes.TAG },
      selector: { type: SchemaFieldTypes.TAG },
      source: { type: SchemaFieldTypes.TAG },
      trust: { type: SchemaFieldTypes.TAG },
      timestamp: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
    },
    { PREFIX: rkey.RKEY_4BYTE_ABI_PREFIX + ':' }
  );
}

/**
 * Drops and recreates all three Cannon-managed query indexes.
 *
 * `dropIndex` is intentionally called without `DD`, so package, canonical ABI,
 * and 4byte source hashes remain available for the rebuilt indexes.
 */
export async function recreateIndexes(redis: RedisClientType) {
  const existingIndexes = new Set(await redis.ft._list());
  for (const indexName of [rkey.RKEY_PACKAGE_SEARCHABLE, rkey.RKEY_ABI_SEARCHABLE, rkey.RKEY_4BYTE_ABI_SEARCHABLE]) {
    if (existingIndexes.has(indexName)) {
      await redis.ft.dropIndex(indexName);
    }
  }
  await initializeIndexes(redis);
}

/**
 * Initializes the managed indexes only when Redis reports no indexes at all.
 *
 * It deliberately does not repair a partial index set; operators must run the
 * explicit recreation command for deterministic recovery from partial state.
 */
export async function createIndexesIfNedeed(redis: RedisClientType) {
  if (!(await redis.ft._list()).length) {
    await initializeIndexes(redis);
  }
}
