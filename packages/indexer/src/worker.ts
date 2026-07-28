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

interface WorkerSupervisorSignal {
  requested: Promise<void>;
  signal: AbortSignal;
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

/**
 * Creates the artifact worker and, by default, gates queue consumption on Redis
 * plus reader/writer facade readiness.
 *
 * The caller owns the returned service and must call `close()`. Startup failure
 * force-closes partially initialized BullMQ resources before rejecting with a
 * redacted diagnostic.
 */
export async function startArtifactWorker(environment: unknown = process.env, options: ArtifactWorkerOptions = {}) {
  const config = loadArtifactWorkerConfig(environment);
  const ownsQueue = !options.queue;
  const queue = options.queue ?? createQueue(config);
  const client = options.client ?? createArtifactFacadeClient(config);
  const requireReadiness = options.waitUntilReady !== false;
  const activeJobs = new AbortController();
  const onShutdown = () => activeJobs.abort();
  if (options.shutdownSignal?.aborted) {
    activeJobs.abort();
  } else {
    options.shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  }
  const worker = startPinningWorker(queue, config, client, {
    autorun: !requireReadiness,
    shutdownSignal: activeJobs.signal,
  });
  let forceResourceClose = false;
  const closeResources = createRetryableResourceCloser(
    () => [ownsQueue ? queue : worker],
    'artifact worker cleanup failed',
    () => (ownsQueue ? queue.close(forceResourceClose) : worker.close(forceResourceClose))
  );
  let shutdownListenerDisposed = false;
  let stopped = new Promise<void>(() => undefined);

  async function close(force = false) {
    activeJobs.abort();
    forceResourceClose ||= force;
    await closeResources();
    if (!shutdownListenerDisposed) {
      options.shutdownSignal?.removeEventListener('abort', onShutdown);
      shutdownListenerDisposed = true;
    }
  }

  if (!requireReadiness) return { client, close, queue, stopped, worker };

  try {
    await withTimeout(
      Promise.all([worker.waitUntilReady(), client.checkHealth(activeJobs.signal)]),
      config.ARTIFACT_READINESS_TIMEOUT_MS,
      'artifact worker readiness'
    );
    if (activeJobs.signal.aborted) throw new Error('artifact worker startup cancelled');
    stopped = worker.run().then(
      () => undefined,
      () => undefined
    );
    return { client, close, queue, stopped, worker };
  } catch {
    // No job should have started before readiness, so force-disconnect BullMQ
    // initialization rather than waiting through its Redis retry strategy.
    await close(true);
    // BullMQ and HTTP-client readiness errors may contain connection URLs or
    // credentials. Keep the executable boundary diagnostic intentionally
    // generic while still failing closed.
    throw new Error('artifact worker readiness failed');
  }
}

/**
 * Waits for an explicit shutdown request and treats an independently stopped
 * BullMQ worker as fatal so the process supervisor can restart it.
 */
export async function waitForArtifactWorkerShutdown(shutdown: WorkerSupervisorSignal, stopped: Promise<void>) {
  const outcome = await Promise.race([
    shutdown.requested.then(() => 'shutdown' as const),
    stopped.then(() => 'worker-stopped' as const),
  ]);
  if (outcome === 'worker-stopped' && !shutdown.signal.aborted) {
    throw new Error('artifact worker stopped unexpectedly');
  }
}

/**
 * Runs the supervised artifact-worker entrypoint.
 *
 * Signal-driven shutdown aborts active artifact requests and drains owned
 * resources. Startup, runtime, and cleanup failures reject to the executable
 * boundary, which sets a non-zero exit code without logging secrets.
 */
export async function runArtifactWorker(environment: unknown = process.env) {
  const shutdown = listenForShutdown();
  let service: Awaited<ReturnType<typeof startArtifactWorker>> | undefined;

  try {
    service = await startArtifactWorker(environment, { shutdownSignal: shutdown.signal });
    await waitForArtifactWorkerShutdown(shutdown, service.stopped);
  } finally {
    shutdown.dispose();
    await service?.close();
  }
}

if (require.main === module) {
  void runArtifactWorker().catch((error: unknown) => {
    // Do not print configuration, bearer tokens, or unvalidated queue payloads.
    const message = error instanceof Error ? error.message : 'unknown failure';
    // Cleanup has already been attempted. A pending TCPConnectWrap can outlive
    // BullMQ/ioredis close promises briefly, so preserve natural process exit;
    // the integration regression bounds that cleanup path.
    process.exitCode = 1;
    // eslint-disable-next-line no-console
    console.error(`artifact worker failed: ${message}`);
  });
}
