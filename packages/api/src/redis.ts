import { commandOptions, createClient, RedisClientType } from 'redis';
import { config } from './config';
import * as keys from './db/keys';
import { ServiceUnavailableError } from './errors';
import { errorIdentity } from './logging';

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
  console.error('Redis connection error', errorIdentity(error));
});

type RedisLifecycleClient = {
  readonly isOpen: boolean;
  readonly isReady: boolean;
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  off: (event: 'end' | 'ready', listener: () => void) => unknown;
  once: (event: 'end' | 'ready', listener: () => void) => unknown;
};

function waitForRedisReady(redis: RedisLifecycleClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      redis.off('ready', onReady);
      redis.off('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new ServiceUnavailableError('Redis connection closed before becoming ready'));
    };

    redis.once('ready', onReady);
    redis.once('end', onEnd);
    if (redis.isReady) onReady();
    else if (!redis.isOpen) onEnd();
  });
}

export function createRedisLifecycle(redis: RedisLifecycleClient) {
  let connection: Promise<void> | undefined;

  const establishConnection = async () => {
    if (!redis.isOpen) await redis.connect();
    if (!redis.isReady) await waitForRedisReady(redis);
  };

  const connect = async (): Promise<void> => {
    if (redis.isReady) return;
    if (!connection) {
      const attempt = establishConnection();
      connection = attempt;
      const clearAttempt = () => {
        if (connection === attempt) connection = undefined;
      };
      void attempt.then(clearAttempt, clearAttempt);
    }
    await connection;
  };

  const disconnect = async (): Promise<void> => {
    try {
      if (redis.isOpen) await redis.disconnect();
    } finally {
      connection = undefined;
    }
  };

  return { connect, disconnect };
}

const lifecycle = createRedisLifecycle(client);

export async function connectRedis(): Promise<void> {
  await lifecycle.connect();
}

export async function disconnectRedis(): Promise<void> {
  await lifecycle.disconnect();
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
