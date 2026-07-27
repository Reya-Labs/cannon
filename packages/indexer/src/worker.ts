import { createArtifactFacadeClient } from './artifact-client';
import type { ArtifactFacadeClient } from './artifact-client';
import { createQueue } from './queue';
import type { Queue } from './queue';
import { startPinningWorker } from './queue/pinning';
import { listenForShutdown } from './shutdown';
import { loadArtifactWorkerConfig } from './worker-config';

interface ArtifactWorkerOptions {
  client?: ArtifactFacadeClient;
  queue?: Queue;
  waitUntilReady?: boolean;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function startArtifactWorker(environment: unknown = process.env, options: ArtifactWorkerOptions = {}) {
  const config = loadArtifactWorkerConfig(environment);
  const ownsQueue = !options.queue;
  const queue = options.queue ?? createQueue(config);
  const client = options.client ?? createArtifactFacadeClient(config);
  const worker = startPinningWorker(queue, config, client);
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    if (ownsQueue) {
      await queue.close();
    } else {
      await worker.close();
    }
  }

  if (options.waitUntilReady === false) return { client, close, queue, worker };

  try {
    await withTimeout(
      Promise.all([worker.waitUntilReady(), client.checkHealth()]),
      config.ARTIFACT_READINESS_TIMEOUT_MS,
      'artifact worker readiness'
    );
    return { client, close, queue, worker };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runArtifactWorker(environment: unknown = process.env) {
  const shutdown = listenForShutdown();
  let service: Awaited<ReturnType<typeof startArtifactWorker>> | undefined;

  try {
    service = await startArtifactWorker(environment);
    await shutdown.requested;
  } finally {
    shutdown.dispose();
    await service?.close();
  }
}

if (require.main === module) {
  void runArtifactWorker().catch((error: unknown) => {
    // Do not print configuration, bearer tokens, or unvalidated queue payloads.
    const message = error instanceof Error ? error.message : 'unknown failure';
    // eslint-disable-next-line no-console
    console.error(`artifact worker failed: ${message}`);
    process.exitCode = 1;
  });
}
