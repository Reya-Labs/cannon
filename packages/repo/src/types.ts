import type { Busboy } from 'busboy';
import type { Express } from 'express';
import type { Config } from './config';
import type { RedisClientType } from 'redis';
import type { S3Client } from './s3';

export type S3ReadClient = Pick<S3Client, 'healthCheck' | 'objectExists' | 'getObject' | 'clearCache'>;
export type S3WriteClient = S3Client;

export interface RepoRequest extends Express.Request {
  busboy: Busboy;
  query: {
    [key: string]: string | string[] | undefined;
  };
  headers: {
    [key: string]: string | string[] | undefined;
    authorization?: string;
  };
}

export interface RepoContext {
  config: Config;
  rdb: RedisClientType;
  s3Read: S3ReadClient;
  s3Write: S3WriteClient;
}
