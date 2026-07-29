import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { QuorumService } from './quorum';
import { UpstreamClient } from './upstream';

export async function startServer(): Promise<{ close: () => Promise<void>; server: Server }> {
  const config = loadConfig();
  const upstream = new UpstreamClient(config.upstreams, config.quorum.timeoutMs, config.limits.responseBytes);
  const quorum = new QuorumService(config, upstream);
  const server = createServer(createApp(config, quorum));
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = config.quorum.timeoutMs * 3;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`Cannon RPC gateway listening on port ${config.port}`);
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    server,
  };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Cannon RPC gateway failed to start', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    process.exitCode = 1;
  });
}
