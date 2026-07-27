import { createQueue } from './queue';
import type { Queue } from './queue';
import { startPinningWorker } from './queue/pinning';
import { loadArtifactWorkerConfig } from './worker-config';

export async function startArtifactWorker(
  environment: unknown = process.env,
  options: { queue?: Queue; waitUntilReady?: boolean } = {}
) {
  const config = loadArtifactWorkerConfig(environment);
  const ownsQueue = !options.queue;
  const queue = options.queue ?? createQueue(config);
  const worker = startPinningWorker(queue, config);

  if (!options.waitUntilReady) return { queue, worker };

  try {
    await worker.waitUntilReady();
    return { queue, worker };
  } catch (err) {
    await worker.close();
    if (ownsQueue) await queue.close();
    throw err;
  }
}

if (require.main === module) {
  void startArtifactWorker(process.env, { waitUntilReady: true }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('artifact worker failed to start', err);
    process.exit(1);
  });
}
