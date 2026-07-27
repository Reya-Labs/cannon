import { createArtifactFacadeClient } from './artifact-client';
import type { ArtifactFacadeClient } from './artifact-client';
import { createQueue } from './queue';
import type { Queue } from './queue';
import { startPinningWorker } from './queue/pinning';
import { createRetryableResourceCloser, listenForShutdown } from './shutdown';
import { loadArtifactWorkerConfig } from './worker-config';

interface ArtifactWorkerOptions {
  client?: ArtifactFacadeClient;
  queue?: Queue;
  shutdownSignal?: AbortSignal;
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
  const activeJobs = new AbortController();
  const onShutdown = () => activeJobs.abort();
  if (options.shutdownSignal?.aborted) {
    activeJobs.abort();
  } else {
    options.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  }
  const worker = startPinningWorker(queue, config, client, { shutdownSignal: activeJobs.signal });
  const closeResources = createRetryableResourceCloser(() => [ownsQueue ? queue : worker], 'artifact worker cleanup failed');
  let shutdownListenerDisposed = false;

  async function close() {
    activeJobs.abort();
    await closeResources();
    if (!shutdownListenerDisposed) {
      options.shutdownSignal?.removeEventListener('abort', onShutdown);
      shutdownListenerDisposed = true;
    }
  }

  if (options.waitUntilReady === false) return { client, close, queue, worker };

  try {
    await withTimeout(
      Promise.all([worker.waitUntilReady(), client.checkHealth(activeJobs.signal)]),
      config.ARTIFACT_READINESS_TIMEOUT_MS,
      'artifact worker readiness'
    );
    return { client, close, queue, worker };
  } catch {
    await close();
    // BullMQ and HTTP-client readiness errors may contain connection URLs or
    // credentials. Keep the executable boundary diagnostic intentionally
    // generic while still failing closed.
    throw new Error('artifact worker readiness failed');
  }
}

export async function runArtifactWorker(environment: unknown = process.env) {
  const shutdown = listenForShutdown();
  let service: Awaited<ReturnType<typeof startArtifactWorker>> | undefined;

  try {
    service = await startArtifactWorker(environment, { shutdownSignal: shutdown.signal });
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
