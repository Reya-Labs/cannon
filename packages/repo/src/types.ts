import type { Busboy } from 'busboy';
import type { Express } from 'express';
import type { Config } from './config';
import type { RedisClientType } from 'redis';
import type { ObjectStoreReadClient, ObjectStoreWriteClient } from './object-store';

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
  rdb?: RedisClientType;
  objectStoreRead?: ObjectStoreReadClient;
  objectStoreWrite?: ObjectStoreWriteClient;
}

export interface AddContext {
  config: Config;
  rdb: RedisClientType;
  objectStoreWrite: ObjectStoreWriteClient;
}

export interface CatContext {
  objectStoreRead: ObjectStoreReadClient;
}

export type HealthContext = Pick<RepoContext, 'config' | 'rdb' | 'objectStoreRead' | 'objectStoreWrite'>;
export type AuthenticationContext = Pick<RepoContext, 'config'>;
