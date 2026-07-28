import { extractValidCid } from '@usecannon/builder';
import { startArtifactWorker } from '../src/worker';

async function main() {
  const cids = process.argv.slice(2).map(extractValidCid).filter(Boolean);

  const { queue } = await startArtifactWorker(process.env, { waitUntilReady: true });

  const batch = queue.createBatch();
  for (const cid of cids) batch.add('PIN_PACKAGE', { cid });
  await batch.exec();

  await queue.waitForIdle();
  await queue.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
