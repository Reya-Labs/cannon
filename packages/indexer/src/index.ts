export * from './db';

import { loop } from './registry';
import { reportRegistryFailure } from './registry-event-failure';
import { listenForShutdown } from './shutdown';

/**
 * Runs the registry producer until shutdown or a terminal scan failure.
 *
 * SIGINT/SIGTERM abort the scan loop; the loop owns and closes its Redis and
 * BullMQ resources before this promise settles.
 */
export async function runRegistryProcess() {
  const shutdown = listenForShutdown();

  try {
    await loop({ signal: shutdown.signal });
  } finally {
    shutdown.dispose();
  }
}

if (require.main === module) {
  void runRegistryProcess().catch((error: unknown) => {
    reportRegistryFailure('process', error);
    process.exitCode = 1;
  });
}
