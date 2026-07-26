import { createClient } from 'redis';

export type ActualRedisClientType = ReturnType<typeof createClient>;

export async function useRedis(redisUrl: string): Promise<ActualRedisClientType> {
  const client: ActualRedisClientType = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries, err) => {
        // After 5 retries, halt the server
        if (retries > 5) {
          // eslint-disable-next-line no-console
          console.error(err);
          process.exit(1);
        }

        return 5_000; // retry after 5 secs
      },
    },
  });

  client.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log(' · redis connected ·');
  });

  client.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
  });

  await client.connect();

  return client;
}
