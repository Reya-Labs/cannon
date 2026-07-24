import 'dotenv/config';

import { version } from '../package.json';
import { loadConfig } from './config';
import { createApp } from './app';
import { getObjectStoreReadClient, getObjectStoreWriteClient } from './object-store';
import { getDb } from './db';
import { RepoContext } from './types';

async function main() {
  const config = loadConfig(process.env);
  const readerEnabled = config.REPO_ROLE === 'reader' || config.REPO_ROLE === 'combined';
  const writerEnabled = config.REPO_ROLE === 'writer' || config.REPO_ROLE === 'combined';

  const ctx: RepoContext = { config };

  if (readerEnabled) {
    ctx.objectStoreRead = getObjectStoreReadClient(config);
  }

  if (writerEnabled) {
    ctx.objectStoreWrite = getObjectStoreWriteClient(config);
    ctx.rdb = await getDb(config.REDIS_URL);
  }

  const app = createApp(ctx);

  const server = await app.start();

  console.log(`\n · version: ${version} · endpoint: http://127.0.0.1:${config.PORT} ·`);

  server.on('close', async () => {
    await ctx.rdb?.quit();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
