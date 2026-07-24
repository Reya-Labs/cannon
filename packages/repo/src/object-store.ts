import type { Config } from './config';
import { getGcsClient } from './gcs';
import { getS3Client } from './s3';

export interface ObjectStoreReadClient {
  healthCheck(): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  getObject(key: string): Promise<Uint8Array>;
  clearCache(): Promise<void>;
}

export interface ObjectStoreWriteClient extends ObjectStoreReadClient {
  putObject(key: string, data: Buffer): Promise<void>;
}

export function getObjectStoreReadClient(config: Config): ObjectStoreReadClient {
  if (config.OBJECT_STORE_PROVIDER === 'gcs') {
    return getGcsClient(config, {
      cache: config.MEMORY_CACHE,
      enforceConditionalWrites: false,
    });
  }

  return getS3Client(config, {
    credentials: {
      accessKeyId: config.S3_READ_KEY,
      secretAccessKey: config.S3_READ_SECRET,
    },
    cache: config.MEMORY_CACHE,
    enforceConditionalWrites: false,
  });
}

export function getObjectStoreWriteClient(config: Config): ObjectStoreWriteClient {
  if (config.OBJECT_STORE_PROVIDER === 'gcs') {
    return getGcsClient(config, {
      cache: config.MEMORY_CACHE,
    });
  }

  return getS3Client(config, {
    credentials: {
      accessKeyId: config.S3_WRITE_KEY,
      secretAccessKey: config.S3_WRITE_SECRET,
    },
    cache: config.MEMORY_CACHE,
  });
}
