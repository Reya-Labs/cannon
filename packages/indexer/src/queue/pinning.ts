import type { WorkerOptions } from '../helpers/create-queue';
import type { ArtifactWorkerConfig } from '../worker-config';
import type { ArtifactFacadeClient } from '../artifact-client';
import { mirrorArtifactClosure, mirrorSingleArtifact } from '../artifact-closure';
import { validatePinningJobData } from './contracts';
import type { PinningJobData } from './contracts';
import type { Queue } from './index';

interface PinningWorkerOptions {
  concurrency?: number;
  shutdownSignal?: AbortSignal;
}

async function runArtifactJob<T>(
  shutdownSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (shutdownSignal?.aborted) throw new Error('artifact job cancelled');

  const controller = new AbortController();
  let timedOut = false;
  const jobError = () => new Error(timedOut ? 'artifact job timed out' : 'artifact job cancelled');
  const onShutdown = () => controller.abort();
  shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(jobError()), { once: true });
  });

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted) throw jobError();
    throw error;
  } finally {
    clearTimeout(timeout);
    shutdownSignal?.removeEventListener('abort', onShutdown);
  }
}

export function createPinningHandlers(
  client: ArtifactFacadeClient,
  config: ArtifactWorkerConfig,
  shutdownSignal?: AbortSignal
) {
  return [
    {
      name: 'PIN_CID' as const,
      async handler(data: PinningJobData) {
        const validated = validatePinningJobData(data);
        if (validated.metadataCids) {
          throw new Error('PIN_CID does not accept metadataCids');
        }
        await runArtifactJob(shutdownSignal, config.ARTIFACT_JOB_TIMEOUT_MS, (signal) =>
          mirrorSingleArtifact(client, validated.cid, config, signal)
        );
      },
    },
    {
      name: 'PIN_PACKAGE' as const,
      async handler(data: PinningJobData) {
        const validated = validatePinningJobData(data);
        await runArtifactJob(shutdownSignal, config.ARTIFACT_JOB_TIMEOUT_MS, (signal) =>
          mirrorArtifactClosure(client, validated.cid, validated.metadataCids ?? [], config, signal)
        );
      },
    },
  ];
}

export function startPinningWorker(
  queue: Queue,
  config: ArtifactWorkerConfig,
  client: ArtifactFacadeClient,
  options?: PinningWorkerOptions
) {
  const workerOptions: WorkerOptions | undefined =
    options?.concurrency === undefined ? undefined : { concurrency: options.concurrency };
  return queue.createWorker(createPinningHandlers(client, config, options?.shutdownSignal), workerOptions);
}
