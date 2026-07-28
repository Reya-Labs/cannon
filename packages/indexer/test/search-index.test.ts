/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RKEY_4BYTE_ABI_PREFIX, RKEY_4BYTE_ABI_SEARCHABLE, RKEY_ABI_SEARCHABLE, RKEY_PACKAGE_SEARCHABLE } from '../src/db';
import { initializeIndexes, recreateIndexes } from '../src/search-indexes';

describe('search index trust boundaries', () => {
  it('keeps untrusted 4byte records out of the canonical ABI index', async () => {
    const created: Array<{ name: string; options: { PREFIX: string | string[] }; schema: unknown }> = [];
    const redis = {
      ft: {
        alter: async () => undefined,
        create: async (name: string, schema: unknown, options: { PREFIX: string | string[] }) => {
          created.push({ name, options, schema });
        },
      },
    };

    await initializeIndexes(redis as unknown as Parameters<typeof initializeIndexes>[0]);

    assert.deepEqual(
      created.map(({ name }) => name),
      [RKEY_PACKAGE_SEARCHABLE, RKEY_ABI_SEARCHABLE, RKEY_4BYTE_ABI_SEARCHABLE]
    );
    assert.equal(created.find(({ name }) => name === RKEY_ABI_SEARCHABLE)?.options.PREFIX, `${RKEY_ABI_SEARCHABLE}:`);
    assert.equal(
      created.find(({ name }) => name === RKEY_4BYTE_ABI_SEARCHABLE)?.options.PREFIX,
      `${RKEY_4BYTE_ABI_PREFIX}:`
    );
  });

  it('recreates all indexes repeatably without deleting source records', async () => {
    const indexes = new Set([RKEY_PACKAGE_SEARCHABLE, RKEY_ABI_SEARCHABLE, RKEY_4BYTE_ABI_SEARCHABLE]);
    const dropped: string[] = [];
    const redis = {
      ft: {
        _list: async () => [...indexes],
        alter: async () => undefined,
        create: async (name: string) => {
          if (indexes.has(name)) throw new Error(`Index already exists: ${name}`);
          indexes.add(name);
        },
        dropIndex: async (name: string) => {
          dropped.push(name);
          indexes.delete(name);
        },
      },
    };
    const client = redis as unknown as Parameters<typeof recreateIndexes>[0];

    await recreateIndexes(client);
    await recreateIndexes(client);

    assert.deepEqual(indexes, new Set([RKEY_PACKAGE_SEARCHABLE, RKEY_ABI_SEARCHABLE, RKEY_4BYTE_ABI_SEARCHABLE]));
    assert.deepEqual(dropped, [
      RKEY_PACKAGE_SEARCHABLE,
      RKEY_ABI_SEARCHABLE,
      RKEY_4BYTE_ABI_SEARCHABLE,
      RKEY_PACKAGE_SEARCHABLE,
      RKEY_ABI_SEARCHABLE,
      RKEY_4BYTE_ABI_SEARCHABLE,
    ]);
  });
});
