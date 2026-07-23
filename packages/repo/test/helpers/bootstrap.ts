import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import { RedisClientType } from 'redis';
import { getDb } from '../../src/db';
import { getS3Client, S3Client } from '../../src/s3';
import { repoServer } from './repo-server';
import { IpfsMock, ipfsServerMock } from './ipfs-server-mock';
import { s3ServerMock } from './s3-server-mock';
import { redisServerMock } from './redis-server-mock';
import { getPort, setInitialRange } from './get-port';
import { generateToken } from '../../src/helpers/tokenUtils';

import type { Config } from '../../src/config';

let bootstrapIndex = 0;

export function bootstrap() {
  const workerId = parseInt(process.env.VITEST_WORKER_ID || '0');
  const bootstrapId = bootstrapIndex++;
  let apiTokenSecret = '';

  const ctx = {} as {
    repo: supertest.Agent;
    rdb: RedisClientType;
    s3: S3Client;
    ipfsMock: IpfsMock;
    redisMock: Awaited<ReturnType<typeof redisServerMock>>;
    s3Mock: Awaited<ReturnType<typeof s3ServerMock>>;
    server: Awaited<ReturnType<typeof repoServer>>;
    authToken: string;
    config: Config;
  };

  beforeAll(async function () {
    // Make sure that the getPort function does not return the same port when called in a row
    const startingPort = 3000 + workerId * 100 + bootstrapId * 10;
    setInitialRange(startingPort);

    const [PORT, ipfsMock, redisMock, s3Mock] = await Promise.all([
      getPort().then((port) => port.toString()),
      ipfsServerMock(),
      redisServerMock(workerId * 4 + bootstrapId),
      s3ServerMock('repo-v2'),
    ]);

    const config: Config = {
      PORT,
      NODE_ENV: 'test',
      TRUST_PROXY: true,
      MEMORY_CACHE: 10_000,
      RATE_LIMIT_MAX: 100_000,
      RATE_LIMIT_WINDOW: 1,
      MAX_ARTIFACT_BYTES: 1024 * 1024,
      MAX_ARCHIVE_FILES: 100,
      MAX_ARCHIVE_EXTRACTED_BYTES: 2 * 1024 * 1024,
      UPSTREAM_TIMEOUT_MS: 5_000,
      REDIS_URL: redisMock.REDIS_URL,
      IPFS_URL: ipfsMock.IPFS_URL,
      S3_ENDPOINT: s3Mock.S3_ENDPOINT,
      S3_BUCKET: s3Mock.S3_BUCKET,
      S3_REGION: s3Mock.S3_REGION,
      S3_KEY: s3Mock.S3_KEY,
      S3_SECRET: s3Mock.S3_SECRET,
      S3_FOLDER: 'repo-v2',
      PINATA_URL: 'https://api.pinata.cloud',
      PINATA_API_JWT: '',
      API_TOKEN_SECRET: 'repo-test-secret',
    };

    const s3 = getS3Client(config, config.MEMORY_CACHE, false);
    const rdb = await getDb(config.REDIS_URL);
    const server = await repoServer({ config, s3, rdb });
    apiTokenSecret = config.API_TOKEN_SECRET;

    // create a client to make requests to the Repo server
    ctx.repo = supertest.agent(server.app);
    ctx.rdb = rdb;
    ctx.s3 = s3;
    ctx.config = config;

    ctx.server = server;
    ctx.ipfsMock = ipfsMock;
    ctx.redisMock = redisMock;
    ctx.s3Mock = s3Mock;
  });

  beforeEach(function () {
    ctx.authToken = generateToken(apiTokenSecret, 60);
  });

  afterEach(async function () {
    ctx.ipfsMock.reset();
    await Promise.all([ctx.s3Mock.reset(), ctx.s3.clearCache()]);
  });

  afterAll(async function () {
    await ctx.server.close();
    await Promise.all([ctx.ipfsMock.close(), ctx.redisMock.close(), ctx.s3Mock.close()]);
  });

  return ctx;
}
