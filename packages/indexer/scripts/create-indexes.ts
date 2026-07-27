import { recreateIndexes } from '../src/search-indexes';
import { useRedis } from '../src/redis';
import { config } from '../src/config';

/**
 * Administrative index-recreation command.
 *
 * From the repository root:
 * `REDIS_URL=rediss://... pnpm --filter @usecannon/indexer exec ts-node scripts/create-indexes.ts`
 *
 * REDIS_URL is required. The command drops and rebuilds only Cannon's managed
 * RediSearch indexes; source hashes are retained for reindexing.
 */
async function main() {
  const redis = await useRedis(config.REDIS_URL);

  await recreateIndexes(redis as any);

  await redis.quit();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
