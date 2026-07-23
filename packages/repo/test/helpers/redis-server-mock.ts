import { RedisMemoryServer } from 'redis-memory-server';
import { createClient } from 'redis';

const servers: RedisMemoryServer[] = [];

function withDatabase(redisUrl: string, database: number) {
  const url = new URL(redisUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function redisServerMock(database = 0) {
  if (process.env.TEST_REDIS_URL) {
    const url = withDatabase(process.env.TEST_REDIS_URL, database);

    return {
      REDIS_URL: url,
      async close() {
        const client = createClient({ url });
        await client.connect();

        try {
          await client.flushDb();
        } finally {
          await client.quit();
        }
      },
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
