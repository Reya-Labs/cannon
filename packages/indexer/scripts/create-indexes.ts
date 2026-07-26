import { recreateIndexes } from '../src/search-indexes';
import { useRedis } from '../src/redis';
import { config } from '../src/config';

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
