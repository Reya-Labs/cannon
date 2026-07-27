export * from './db';

import { loop } from './registry';
import { listenForShutdown } from './shutdown';

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
    // Keep errors free of configuration values and event payloads.
    const message = error instanceof Error ? error.message : 'unknown failure';
    // eslint-disable-next-line no-console
    console.error(`registry process failed: ${message}`);
    process.exitCode = 1;
  });
}
