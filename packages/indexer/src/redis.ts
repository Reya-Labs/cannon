import { createClient } from 'redis';

export type ActualRedisClientType = ReturnType<typeof createClient>;

/**
 * Connects to the explicit Redis URL and returns the ready client.
 *
 * The caller owns the returned client and must close it when its workload ends.
 */
export async function useRedis(redisUrl: string): Promise<ActualRedisClientType> {
  const client: ActualRedisClientType = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        // Let the owning process unwind through its normal shutdown path.
        if (retries > 5) {
          return new Error('Redis reconnect limit exceeded');
        }

        return 5_000; // retry after 5 secs
      },
    },
  });

  client.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log(' · redis connected ·');
  });

  client.on('error', () => {
    // eslint-disable-next-line no-console
    console.error('redis connection error');
  });

  await client.connect();

  return client;
}
