import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { config, type ApiConfig } from './config';
import { errorIdentity } from './logging';
import { checkRedisReadiness, connectRedis as connectRedisClient, disconnectRedis as disconnectRedisClient } from './redis';

type StartServerDependencies = {
  checkReadiness?: (signal: AbortSignal) => Promise<void>;
  config?: ApiConfig;
  connectRedis?: () => Promise<void>;
  disconnectRedis?: () => Promise<void>;
};

function throwCombinedErrors(primaryError: unknown, cleanupError: unknown, message: string): never {
  throw new AggregateError([primaryError, cleanupError], message);
}

/**
 * Starts the query API before connecting to Redis in the background.
 *
 * Injected dependencies support isolated lifecycle tests. Startup and shutdown
 * preserve both primary and cleanup failures in an AggregateError.
 */
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
  } catch (listenError) {
    try {
      await disconnectRedis();
    } catch (disconnectError) {
      throwCombinedErrors(listenError, disconnectError, 'query API startup and Redis cleanup both failed');
    }
    throw listenError;
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
      let closeError: unknown;
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
      } catch (error) {
        closeError = error;
      }

      try {
        await disconnectRedis();
      } catch (disconnectError) {
        if (closeError !== undefined) {
          throwCombinedErrors(closeError, disconnectError, 'query API server and Redis shutdown both failed');
        }
        throw disconnectError;
      }

      if (closeError !== undefined) throw closeError;
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
