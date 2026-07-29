import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { SourceBundleService } from './source';

export async function startServer(): Promise<{ close: () => Promise<void>; server: Server }> {
  const config = loadConfig();
  const server = createServer(createApp(config, new SourceBundleService()));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`Cannon source gateway listening on port ${config.port}`);
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
    console.error('Cannon source gateway failed to start', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    process.exitCode = 1;
  });
}
