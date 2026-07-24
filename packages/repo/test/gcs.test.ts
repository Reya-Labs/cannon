import type { Storage } from '@google-cloud/storage';
import { describe, expect, it } from 'vitest';
import { ConditionalCreatesUnsupportedError, getGcsClient } from '../src/gcs';

interface StoredObject {
  data: Buffer;
}

class FakeGcs {
  readonly objects = new Map<string, StoredObject>();

  constructor(private readonly enforcePreconditions = true) {}

  bucket() {
    return {
      file: (name: string) => ({
        exists: async () => [this.objects.has(name)],
        download: async () => {
          const object = this.objects.get(name);

          if (!object) {
            throw Object.assign(new Error(`object "${name}" not found`), { code: 404 });
          }

          return [Buffer.from(object.data)];
        },
        save: async (
          data: Buffer,
          options?: {
            preconditionOpts?: {
              ifGenerationMatch?: number;
            };
          }
        ) => {
          if (this.enforcePreconditions && options?.preconditionOpts?.ifGenerationMatch === 0 && this.objects.has(name)) {
            throw Object.assign(new Error(`object "${name}" already exists`), { code: 412 });
          }

          this.objects.set(name, { data: Buffer.from(data) });
        },
      }),
    };
  }
}

const config = {
  GCS_PROJECT_ID: 'reya-mainnet',
  GCS_BUCKET: 'reya-cannon-artifacts',
  GCS_FOLDER: 'repo-v2',
};

function client(storage: FakeGcs, enforceConditionalWrites = true) {
  return getGcsClient(config, {
    storage: storage as unknown as Storage,
    enforceConditionalWrites,
  });
}

describe('GCS artifact storage', function () {
  it('allows the reader health check after the writer establishes the capability marker', async function () {
    const storage = new FakeGcs();
    const writer = client(storage);
    const reader = client(storage, false);

    await writer.healthCheck();
    await expect(reader.healthCheck()).resolves.toBeUndefined();
  });

  it('stores immutable objects idempotently', async function () {
    const storage = new FakeGcs();
    const writer = client(storage);

    await writer.putObject('cid', Buffer.from('artifact'));
    await writer.putObject('cid', Buffer.from('artifact'));

    await expect(writer.putObject('cid', Buffer.from('different'))).rejects.toThrow(
      'refusing to overwrite immutable object "cid"'
    );
    await expect(writer.getObject('cid')).resolves.toEqual(Buffer.from('artifact'));
  });

  it('allows only one of two conflicting creates to win', async function () {
    const storage = new FakeGcs();
    const firstWriter = client(storage);
    const secondWriter = client(storage);

    const results = await Promise.allSettled([
      firstWriter.putObject('cid', Buffer.from('first')),
      secondWriter.putObject('cid', Buffer.from('second')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(Buffer.from(await firstWriter.getObject('cid')).toString());
  });

  it('rejects a backend that ignores create-only preconditions', async function () {
    const writer = client(new FakeGcs(false));

    await expect(writer.healthCheck()).rejects.toBeInstanceOf(ConditionalCreatesUnsupportedError);
  });

  it('does not cache a missing object as present', async function () {
    const storage = new FakeGcs();
    const writer = client(storage);

    await expect(writer.objectExists('cid')).resolves.toBe(false);
    await writer.putObject('cid', Buffer.from('artifact'));
    await expect(writer.objectExists('cid')).resolves.toBe(true);
  });
});
