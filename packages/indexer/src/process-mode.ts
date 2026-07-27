import { IndexerProcessMode } from './process-config';
import type { Queue } from './queue';

export interface IndexerProcessRunners {
  runRegistry: (startArtifactWorker?: (queue: Queue) => Promise<void> | void) => Promise<void>;
  startArtifactWorker: (waitUntilReady?: boolean, queue?: Queue) => Promise<void> | void;
  validateArtifactWorker?: () => Promise<void> | void;
}

async function runRegistry(startWorker?: (queue: Queue) => Promise<void> | void) {
  const registry = await import('./registry');
  await registry.loop({ startArtifactWorker: startWorker });
}

async function startArtifactWorker(waitUntilReady = false, queue?: Queue) {
  const artifactWorker = await import('./worker');
  await artifactWorker.startArtifactWorker(process.env, { queue, waitUntilReady });
}

async function validateArtifactWorker() {
  const { loadArtifactWorkerConfig } = await import('./worker-config');
  loadArtifactWorkerConfig(process.env);
}

/**
 * `combined` remains the compatibility default. Selecting `registry` is the
 * explicit transition to an unprivileged producer process and must be paired
 * with a separately supervised `artifact-worker` process.
 */
export async function runIndexerProcess(
  mode: IndexerProcessMode,
  runners: IndexerProcessRunners = { runRegistry, startArtifactWorker, validateArtifactWorker }
) {
  switch (mode) {
    case 'registry':
      await runners.runRegistry();
      return;
    case 'artifact-worker':
      await runners.startArtifactWorker(true);
      return;
    case 'combined':
      await runners.validateArtifactWorker?.();
      await runners.runRegistry((queue) => runners.startArtifactWorker(false, queue));
      return;
  }
}
