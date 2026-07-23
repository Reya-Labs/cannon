import { createServer, type Server } from 'node:http';
import Redis from 'ioredis';
import { createPublicClient, http } from 'viem';
import { PilotAdmissionVerifier } from './admission';
import { createApp } from './app';
import { loadConfig } from './config';
import { checkSafeReadiness } from './safe';
import { RedisStagingStore } from './store';
import type { ProviderRegistry, SafeClient } from './types';

function errorCode(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return fallback;
}

export async function startServer(): Promise<{
  close: () => Promise<void>;
  server: Server;
}> {
  const config = loadConfig();
  if (!config.pilotMode) {
    throw new Error(
      'production admission verifier is not configured; PILOT_MODE=true is permitted only for the bounded test-Safe pilot'
    );
  }
  const redis = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', (error) => {
    console.error('persistence backend error', {
      code: errorCode(error, 'unknown'),
      name: error.name,
    });
  });

  const store = new RedisStagingStore(redis, config.redisPrefix, {
    auditMaxLength: config.auditMaxLength,
    historyRetentionMs: config.historyRetentionMs,
    maxProposalsPerNonce: config.maxProposalsPerNonce,
    minReplicas: config.redisMinReplicas,
    waitTimeoutMs: config.redisWaitTimeoutMs,
  });
  let server: Server | undefined;

  try {
    await redis.connect();
    await store.ping();

    const providers: ProviderRegistry = new Map();
    for (const [chainId, rpcUrl] of config.rpcUrls) {
      const client = createPublicClient({
        transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }),
      }) as unknown as SafeClient;
      const actualChainId = await client.getChainId();
      if (actualChainId !== chainId) {
        throw new Error(`RPC_URLS chain mismatch: configured ${chainId}, endpoint returned ${actualChainId}`);
      }
      providers.set(chainId, client);
    }

    await Promise.all(
      config.safeTargets.map(({ address, chainId }) =>
        checkSafeReadiness(providers.get(chainId)!, address, chainId, config.maxBlockAgeSeconds)
      )
    );

    const app = createApp({
      admissionVerifier: new PilotAdmissionVerifier(config.pilotMode),
      config,
      providers,
      store,
    });
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(config.port, () => {
        server!.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    store.forceDisconnect();
    throw error;
  }

  const chainIds = Array.from(config.rpcUrls.keys()).join(',');
  console.log(`safe staging backend listening on port ${config.port}; chains=${chainIds}; pilotMode=${config.pilotMode}`);

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await store.disconnect();
    },
    server,
  };
}

if (require.main === module) {
  startServer()
    .then(({ close }) => {
      const shutdown = async (signal: string) => {
        console.log(`received ${signal}; shutting down`);
        try {
          await close();
          process.exitCode = 0;
        } catch (error) {
          console.error('graceful shutdown failed', {
            code: errorCode(error, 'shutdown_failed'),
            name: error instanceof Error ? error.name : 'unknown',
          });
          process.exitCode = 1;
        }
      };
      process.once('SIGINT', () => void shutdown('SIGINT'));
      process.once('SIGTERM', () => void shutdown('SIGTERM'));
    })
    .catch((error) => {
      console.error('safe staging backend failed to start', {
        code: errorCode(error, 'startup_failed'),
        name: error instanceof Error ? error.name : 'unknown',
      });
      process.exitCode = 1;
    });
}
