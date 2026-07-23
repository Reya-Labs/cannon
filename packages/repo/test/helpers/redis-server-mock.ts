import { RedisMemoryServer } from 'redis-memory-server';

const servers: RedisMemoryServer[] = [];

function withDatabase(redisUrl: string, database: number) {
  const url = new URL(redisUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function redisServerMock(database = 0) {
  if (process.env.TEST_REDIS_URL) {
    return {
      REDIS_URL: withDatabase(process.env.TEST_REDIS_URL, database),
      close: async () => undefined,
    };
  }

  const server = new RedisMemoryServer();

  servers.push(server);

  const host = await server.getHost();
  const port = await server.getPort();

  return {
    REDIS_URL: `redis://${host}:${port}/${database}`,
    close: server.stop.bind(server),
  };
}
