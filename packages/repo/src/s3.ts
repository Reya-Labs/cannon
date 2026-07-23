import { S3 } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import memoize from 'memoizee';
import promiseRetry from 'promise-retry';

export type S3Client = ReturnType<typeof getS3Client>;

interface Params {
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_FOLDER: string;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

interface S3ClientOptions {
  credentials: S3Credentials;
  cache?: number;
  enforceConditionalWrites?: boolean;
}

const retryOptions = {
  retries: 3,
  minTimeout: 500,
  maxTimeout: 3000,
};

class ConditionalWritesUnsupportedError extends Error {
  constructor() {
    super('S3 backend does not enforce atomic If-None-Match conditional writes');
    this.name = 'ConditionalWritesUnsupportedError';
  }
}

function isPreconditionFailure(err: unknown) {
  return (
    err instanceof Error &&
    (err.name === 'PreconditionFailed' ||
      ('$metadata' in err &&
        typeof err.$metadata === 'object' &&
        err.$metadata !== null &&
        'httpStatusCode' in err.$metadata &&
        err.$metadata.httpStatusCode === 412))
  );
}

function retryS3<T>(operation: () => Promise<T>, shouldRetry: (err: unknown) => boolean = () => true) {
  return promiseRetry(async (retry) => {
    try {
      return await operation();
    } catch (err) {
      if (!shouldRetry(err)) throw err;
      return retry(err);
    }
  }, retryOptions);
}

export function getS3Client(
  config: Params,
  { credentials, cache = 10_000, enforceConditionalWrites = true }: S3ClientOptions
) {
  const client = new S3({
    forcePathStyle: false, // Configures to use subdomain/virtual calling format.
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials,
  });

  const cacheOptions = {
    length: 1,
    primitive: true,
    promise: true,
    max: cache,
  };

  const capabilityKeyPrefix = `${config.S3_FOLDER}/.cannon/conditional-put-v1`;
  const capabilityMarker = Buffer.from('cannon-repo-conditional-put-v1');
  const conflictingMarker = Buffer.from('cannon-repo-conditional-put-conflict');
  let conditionalWriteValidation: Promise<void> | undefined;

  async function validateConditionalWrites() {
    if (!enforceConditionalWrites) return;

    conditionalWriteValidation ??= (async () => {
      const capabilityKey = `${capabilityKeyPrefix}/${randomUUID()}`;

      try {
        await retryS3(
          () =>
            client.putObject({
              Bucket: config.S3_BUCKET,
              Key: capabilityKey,
              Body: capabilityMarker,
              IfNoneMatch: '*',
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) throw err;
      }

      let conflictRejected = false;

      try {
        await retryS3(
          () =>
            client.putObject({
              Bucket: config.S3_BUCKET,
              Key: capabilityKey,
              Body: conflictingMarker,
              IfNoneMatch: '*',
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) throw err;
        conflictRejected = true;
      }

      const stored = await retryS3(() =>
        client.getObject({
          Bucket: config.S3_BUCKET,
          Key: capabilityKey,
        })
      );
      const storedBytes = stored.Body ? Buffer.from(await stored.Body.transformToByteArray()) : null;

      if (!conflictRejected || !storedBytes?.equals(capabilityMarker)) {
        throw new ConditionalWritesUnsupportedError();
      }
    })().catch((err) => {
      if (!(err instanceof ConditionalWritesUnsupportedError)) {
        conditionalWriteValidation = undefined;
      }

      throw err;
    });

    return conditionalWriteValidation;
  }

  const cachedObjectExists = memoize(async function cachedObjectExists(key: string) {
    console.log('[s3][objectExists]', key);

    return retryS3(async () => {
      try {
        await client.headObject({ Bucket: config.S3_BUCKET, Key: `${config.S3_FOLDER}/${key}` });
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFound') {
          return false;
        }

        throw err;
      }
    });
  }, cacheOptions);

  async function objectExists(key: string) {
    const exists = await cachedObjectExists(key);

    if (!exists) {
      await cachedObjectExists.delete(key);
    }

    return exists;
  }

  const s3 = {
    client,

    async healthCheck() {
      await Promise.all([client.headBucket({ Bucket: config.S3_BUCKET }), validateConditionalWrites()]);
    },

    objectExists,

    async putObject(key: string, data: Buffer) {
      console.log('[s3][putObject]', key);
      await validateConditionalWrites();

      if (await s3.objectExists(key)) {
        const existing = Buffer.from(await s3.getObject(key));

        if (!existing.equals(data)) {
          throw new Error(`refusing to overwrite immutable object "${key}"`);
        }

        return;
      }

      try {
        await retryS3(
          () =>
            client.putObject({
              Bucket: config.S3_BUCKET,
              Key: `${config.S3_FOLDER}/${key}`,
              Body: data,
              ContentType: 'application/octet-stream',
              CacheControl: 'private, max-age=31536000, immutable',
              IfNoneMatch: '*',
            }),
          (err) => !isPreconditionFailure(err)
        );
      } catch (err) {
        if (!isPreconditionFailure(err)) {
          throw err;
        }

        const existing = Buffer.from(await s3.getObject(key));

        if (!existing.equals(data)) {
          throw new Error(`refusing to overwrite immutable object "${key}"`);
        }
      }

      await cachedObjectExists.delete(key);
      await s3.getObject.delete(key);
    },

    getObject: memoize(async function getObject(key: string) {
      console.log('[s3][getObject]', key);

      const res = await retryS3(() =>
        client.getObject({
          Bucket: config.S3_BUCKET,
          Key: `${config.S3_FOLDER}/${key}`,
        })
      );

      if (!res.Body) {
        throw new Error(`no response body for "${key}"`);
      }

      return res.Body!.transformToByteArray();
    }, cacheOptions),

    async clearCache() {
      await cachedObjectExists.clear();
      await s3.getObject.clear();
    },
  };

  return s3;
}
