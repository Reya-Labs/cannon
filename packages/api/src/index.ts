import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { config, type ApiConfig } from './config';
import { checkRedisReadiness, connectRedis as connectRedisClient, disconnectRedis as disconnectRedisClient } from './redis';

function errorIdentity(error: unknown): { code: string; name: string } {
  return {
    code:
      typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unexpected',
    name: error instanceof Error ? error.name : 'unknown',
  };
}

type StartServerDependencies = {
  checkReadiness?: (signal: AbortSignal) => Promise<void>;
  config?: ApiConfig;
  connectRedis?: () => Promise<void>;
  disconnectRedis?: () => Promise<void>;
};

export async function startServer(
  dependencies: StartServerDependencies = {}
): Promise<{ close: () => Promise<void>; server: Server }> {
  const runtimeConfig = dependencies.config ?? config;
  const connectRedis = dependencies.connectRedis ?? connectRedisClient;
  const disconnectRedis = dependencies.disconnectRedis ?? disconnectRedisClient;
  const server = createServer(
    createApp({
      checkReadiness: dependencies.checkReadiness ?? checkRedisReadiness,
      config: runtimeConfig,
    })
  );
  server.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('query API server socket error', errorIdentity(error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(runtimeConfig.PORT, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await disconnectRedis();
    throw error;
  }

  // eslint-disable-next-line no-console
  console.log(`query API listening on port ${runtimeConfig.PORT}`);
  void Promise.resolve()
    .then(connectRedis)
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('query API background Redis connection failed', errorIdentity(error));
    });

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await new Promise<void>((resolve, reject) => {
          const forceClose = setTimeout(() => server.closeAllConnections(), 5_000);
          forceClose.unref();
          server.close((error) => {
            clearTimeout(forceClose);
            error ? reject(error) : resolve();
          });
          server.closeIdleConnections();
        });
      } finally {
        await disconnectRedis();
      }
    },
    server,
  };
}

if (require.main === module) {
  startServer()
    .then(({ close }) => {
      const shutdown = async (signal: string) => {
        // eslint-disable-next-line no-console
        console.log(`received ${signal}; shutting down`);
        try {
          await close();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('query API graceful shutdown failed', errorIdentity(error));
          process.exitCode = 1;
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('query API failed to start', errorIdentity(error));
      process.exitCode = 1;
    });
}
