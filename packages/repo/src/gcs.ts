import { Storage } from '@google-cloud/storage';
import memoize from 'memoizee';
import promiseRetry from 'promise-retry';

interface Params {
  GCS_BUCKET: string;
  GCS_FOLDER: string;
  GCS_PROJECT_ID: string;
}

interface GcsClientOptions {
  cache?: number;
  enforceConditionalWrites?: boolean;
  storage?: Storage;
}

const retryOptions = {
  retries: 3,
  minTimeout: 500,
  maxTimeout: 3000,
};

const capabilityMarker = Buffer.from('cannon-repo-gcs-conditional-create-v1');
const conflictingMarker = Buffer.from('cannon-repo-gcs-conditional-create-conflict');

export class ConditionalCreatesUnsupportedError extends Error {
  constructor() {
    super('GCS backend does not enforce atomic ifGenerationMatch=0 conditional creates');
    this.name = 'ConditionalCreatesUnsupportedError';
  }
}

function errorCode(err: unknown) {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;

  const code = err.code;
  return typeof code === 'string' ? Number.parseInt(code, 10) : code;
}

function isPreconditionFailure(err: unknown) {
  return errorCode(err) === 412;
}

function retryGcs<T>(operation: () => Promise<T>, shouldRetry: (err: unknown) => boolean = () => true) {
  return promiseRetry(async (retry) => {
    try {
      return await operation();
    } catch (err) {
      if (!shouldRetry(err)) throw err;
      return retry(err);
    }
  }, retryOptions);
}

function objectName(folder: string, key: string) {
  return `${folder.replace(/^\/+|\/+$/g, '')}/${key.replace(/^\/+/, '')}`;
}

export function getGcsClient(
  config: Params,
  { cache = 10_000, enforceConditionalWrites = true, storage: injectedStorage }: GcsClientOptions = {}
) {
  const storage =
    injectedStorage ??
    new Storage({
      projectId: config.GCS_PROJECT_ID || undefined,
    });
  const bucket = storage.bucket(config.GCS_BUCKET);
  const capabilityKey = objectName(config.GCS_FOLDER, '.cannon/capabilities/conditional-create-v1');
  let conditionalWriteValidation: Promise<void> | undefined;

  const cacheOptions = {
    length: 1,
    primitive: true,
    promise: true,
    max: cache,
  };

  async function readCapabilityMarker() {
    const [storedBytes] = await retryGcs(() => bucket.file(capabilityKey).download());

    if (!storedBytes.equals(capabilityMarker)) {
      throw new ConditionalCreatesUnsupportedError();
    }
  }

  async function validateConditionalWrites() {
    if (!enforceConditionalWrites) {
      await readCapabilityMarker();
      return;
    }

    conditionalWriteValidation ??= (async () => {
      const capabilityFile = bucket.file(capabilityKey);

      try {
        await retryGcs(
          () =>
            capabilityFile.save(capabilityMarker, {
              resumable: false,
              validation: 'crc32c',
              preconditionOpts: { ifGenerationMatch: 0 },
              metadata: {
                contentType: 'application/octet-stream',
                cacheControl: 'private, max-age=31536000, immutable',
                metadata: {
                  cannonCapability: 'conditional-create-v1',
                },
              },
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) throw err;
      }

      let conflictRejected = false;

      try {
        await retryGcs(
          () =>
            capabilityFile.save(conflictingMarker, {
              resumable: false,
              validation: 'crc32c',
              preconditionOpts: { ifGenerationMatch: 0 },
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) throw err;
        conflictRejected = true;
      }

      await readCapabilityMarker();

      if (!conflictRejected) {
        throw new ConditionalCreatesUnsupportedError();
      }
    })().catch((err) => {
      if (!(err instanceof ConditionalCreatesUnsupportedError)) {
        conditionalWriteValidation = undefined;
      }

      throw err;
    });

    return conditionalWriteValidation;
  }

  const cachedObjectExists = memoize(async function cachedObjectExists(key: string) {
    console.log('[gcs][objectExists]', key);

    return retryGcs(async () => {
      const [exists] = await bucket.file(objectName(config.GCS_FOLDER, key)).exists();
      return exists;
    });
  }, cacheOptions);

  async function objectExists(key: string) {
    const exists = await cachedObjectExists(key);

    if (!exists) {
      await cachedObjectExists.delete(key);
    }

    return exists;
  }

  const gcs = {
    storage,
    bucket,

    async healthCheck() {
      await validateConditionalWrites();
    },

    objectExists,

    async putObject(key: string, data: Buffer) {
      console.log('[gcs][putObject]', key);
      await validateConditionalWrites();

      try {
        await retryGcs(
          () =>
            bucket.file(objectName(config.GCS_FOLDER, key)).save(data, {
              resumable: false,
              validation: 'crc32c',
              preconditionOpts: { ifGenerationMatch: 0 },
              metadata: {
                contentType: 'application/octet-stream',
                cacheControl: 'private, max-age=31536000, immutable',
              },
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) {
          throw err;
        }

        const existing = Buffer.from(await gcs.getObject(key));

        if (!existing.equals(data)) {
          throw new Error(`refusing to overwrite immutable object "${key}"`);
        }
      }

      await cachedObjectExists.delete(key);
      await gcs.getObject.delete(key);
    },

    getObject: memoize(async function getObject(key: string) {
      console.log('[gcs][getObject]', key);
      const [data] = await retryGcs(() => bucket.file(objectName(config.GCS_FOLDER, key)).download());
      return data;
    }, cacheOptions),

    async clearCache() {
      await cachedObjectExists.clear();
      await gcs.getObject.clear();
    },
  };

  return gcs;
}

export type GcsClient = ReturnType<typeof getGcsClient>;
