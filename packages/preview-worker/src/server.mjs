import http from 'node:http';
import { createApp } from './app.mjs';
import { describeConfig, loadConfig } from './config.mjs';
import { createPreviewRunner } from './preview-runner.mjs';
import { createRegistryResolver } from './registry.mjs';
import { createSimulator } from './simulator.mjs';
import { loadPreviewEngine } from './simulator/engine.mjs';

/**
 * Builds a listening preview worker.
 *
 * Server hardening mirrors the rest of the signer plane: bounded headers,
 * bounded request lifetime, and an immediate socket teardown on malformed
 * framing so a stalled or oversized client cannot hold a slot.
 *
 * The Cannon engine is resolved before the socket is opened. A `fork` worker
 * whose image lacks it never becomes ready, which is the difference between a
 * deployment that fails and one that answers previews from a degraded path.
 */
export async function startServer(env = process.env) {
  const config = loadConfig(env);
  const app = createApp(config, {
    previewRunner: createPreviewRunner({
      rpcUrl: config.rpcUrl,
      simulator: createSimulator({
        artifactOrigin: config.artifactOrigin,
        engine:
          config.simulatorMode === 'disabled'
            ? undefined
            : await loadPreviewEngine(),
        mainnetRpcUrl: config.mainnetRpcUrl,
        mode: config.simulatorMode,
        opRpcUrl: config.opRpcUrl,
        rpcUrl: config.rpcUrl,
        sourceOrigin: config.sourceOrigin,
      }),
    }),
    registryResolver: createRegistryResolver({ opRpcUrl: config.opRpcUrl }),
  });

  const server = http.createServer(app);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 48;
  server.maxRequestsPerSocket = 256;
  server.requestTimeout = 300_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '0.0.0.0', port: config.port }, resolve);
  });
  console.info(
    JSON.stringify({ event: 'listening', ...describeConfig(config) }),
  );

  const stop = async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  return Object.freeze({ config, server, stop });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'startup_failed',
        name: error instanceof Error ? error.name : 'unknown',
      }),
    );
    process.exit(1);
  });
}
