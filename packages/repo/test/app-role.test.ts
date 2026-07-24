import type { RedisClientType } from 'redis';
import { describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { ObjectStoreReadClient, ObjectStoreWriteClient } from '../src/object-store';

const gcsEnvironment = {
  NODE_ENV: 'production',
  OBJECT_STORE_PROVIDER: 'gcs',
  GCS_BUCKET: 'reya-cannon-artifacts',
  GCS_FOLDER: 'repo-v2',
};

function readClient(): ObjectStoreReadClient {
  return {
    healthCheck: vi.fn().mockResolvedValue(undefined),
    objectExists: vi.fn().mockResolvedValue(false),
    getObject: vi.fn().mockResolvedValue(new Uint8Array()),
    clearCache: vi.fn().mockResolvedValue(undefined),
  };
}

function writeClient(): ObjectStoreWriteClient {
  return {
    ...readClient(),
    putObject: vi.fn().mockResolvedValue(undefined),
  };
}

describe('repository roles', function () {
  it('starts a reader without Redis or write credentials and does not mount uploads', async function () {
    const config = loadConfig({
      ...gcsEnvironment,
      REPO_ROLE: 'reader',
    });
    const objectStoreRead = readClient();
    const { app } = createApp({ config, objectStoreRead });
    const repo = supertest(app);

    await repo.get('/health').expect(200);
    await repo.post('/api/v0/add').expect(404);
    expect(objectStoreRead.healthCheck).toHaveBeenCalledOnce();
  });

  it('emits CORS headers only for an exact configured reader origin', async function () {
    const config = loadConfig({
      ...gcsEnvironment,
      REPO_ROLE: 'reader',
      CORS_ALLOWED_ORIGINS: 'https://cannon.example.com',
    });
    const { app } = createApp({ config, objectStoreRead: readClient() });
    const repo = supertest(app);

    await repo
      .get('/health')
      .set('Origin', 'https://cannon.example.com')
      .expect('Access-Control-Allow-Origin', 'https://cannon.example.com')
      .expect(200);

    const deniedOrigin = await repo.get('/health').set('Origin', 'https://malicious.example.com').expect(200);
    expect(deniedOrigin.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('starts a writer without read credentials and does not mount artifact reads', async function () {
    const config = loadConfig({
      ...gcsEnvironment,
      REPO_ROLE: 'writer',
      REDIS_URL: 'redis://localhost:6379',
      API_TOKEN_SECRET: 'token-secret',
    });
    const objectStoreWrite = writeClient();
    const rdb = { ping: vi.fn().mockResolvedValue('PONG') } as unknown as RedisClientType;
    const { app } = createApp({ config, rdb, objectStoreWrite });
    const repo = supertest(app);

    await repo.get('/health').expect(200);
    await repo.post('/api/v0/cat').expect(404);
    const browserRequest = await repo.get('/not-found').set('Origin', 'https://malicious.example.com').expect(404);
    expect(browserRequest.headers['access-control-allow-origin']).toBeUndefined();
    expect(rdb.ping).toHaveBeenCalledOnce();
    expect(objectStoreWrite.healthCheck).toHaveBeenCalledOnce();
  });

  it('fails fast when a configured role is missing its required dependency', function () {
    const config = loadConfig({
      ...gcsEnvironment,
      REPO_ROLE: 'writer',
      REDIS_URL: 'redis://localhost:6379',
      API_TOKEN_SECRET: 'token-secret',
    });

    expect(() => createApp({ config })).toThrow('writer repository role requires Redis and write-capable object storage');
  });
});
