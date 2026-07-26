import { RedisClientType, SchemaFieldTypes } from 'redis';
import * as rkey from './db';
/* eslint no-console: "off" */

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

/** Drops and recreates every query-plane index without deleting source hashes. */
export async function recreateIndexes(redis: RedisClientType) {
  const existingIndexes = new Set(await redis.ft._list());
  for (const indexName of [rkey.RKEY_PACKAGE_SEARCHABLE, rkey.RKEY_ABI_SEARCHABLE, rkey.RKEY_4BYTE_ABI_SEARCHABLE]) {
    if (existingIndexes.has(indexName)) {
      await redis.ft.dropIndex(indexName);
    }
  }
  await initializeIndexes(redis);
}

export async function createIndexesIfNedeed(redis: RedisClientType) {
  if (!(await redis.ft._list()).length) {
    await initializeIndexes(redis);
  }
}
