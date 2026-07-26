import { commandOptions, createClient, RedisClientType } from 'redis';
import { config } from './config';
import * as keys from './db/keys';
import { ServiceUnavailableError } from './errors';

const client: RedisClientType = createClient({
  commandsQueueMaxLength: 100,
  disableOfflineQueue: true,
  url: config.REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      return Math.min(100 * 2 ** retries, 5_000);
    },
  },
});

client.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log(' · redis connected ·');
});

client.on('error', (error) => {
  // eslint-disable-next-line no-console
  console.error('Redis connection error', {
    code:
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unexpected',
    name: error instanceof Error ? error.name : 'unknown',
  });
});

let connection: Promise<void> | undefined;

export async function connectRedis(): Promise<void> {
  if (client.isReady) return;
  if (!connection) {
    connection = client.connect().then(() => undefined);
  }
  try {
    await connection;
  } finally {
    if (!client.isReady) connection = undefined;
  }
}

export async function disconnectRedis(): Promise<void> {
  try {
    if (client.isOpen) await client.disconnect();
  } finally {
    connection = undefined;
  }
}

type ReadinessClient = {
  ft: {
    info: (options: ReturnType<typeof commandOptions<{ signal: AbortSignal }>>, index: string) => Promise<unknown>;
  };
  ping: (options: ReturnType<typeof commandOptions<{ signal: AbortSignal }>>) => Promise<unknown>;
};

export async function checkRedisClientReadiness(redis: ReadinessClient, signal: AbortSignal): Promise<void> {
  await Promise.all([
    redis.ping(commandOptions({ signal })),
    redis.ft.info(commandOptions({ signal }), keys.RKEY_PACKAGE_SEARCHABLE),
    redis.ft.info(commandOptions({ signal }), keys.RKEY_ABI_SEARCHABLE),
  ]);
}

export async function checkRedisReadiness(signal: AbortSignal): Promise<void> {
  const redis = await useRedis();
  await checkRedisClientReadiness(redis, signal);
}

export async function useRedis(): Promise<RedisClientType> {
  if (!client.isReady) throw new ServiceUnavailableError();
  return client;
}
