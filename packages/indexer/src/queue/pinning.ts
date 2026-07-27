import type { WorkerOptions } from '../helpers/create-queue';
import type { ArtifactWorkerConfig } from '../worker-config';
import type { ArtifactFacadeClient } from '../artifact-client';
import { mirrorArtifactClosure, mirrorSingleArtifact } from '../artifact-closure';
import { validatePinningJobData } from './contracts';
import type { PinningJobData } from './contracts';
import type { Queue } from './index';

export function createPinningHandlers(client: ArtifactFacadeClient, config: ArtifactWorkerConfig) {
  return [
    {
      name: 'PIN_CID' as const,
      async handler(data: PinningJobData) {
        const validated = validatePinningJobData(data);
        if (validated.metadataCids) {
          throw new Error('PIN_CID does not accept metadataCids');
        }
        await mirrorSingleArtifact(client, validated.cid, config);
      },
    },
    {
      name: 'PIN_PACKAGE' as const,
      async handler(data: PinningJobData) {
        const validated = validatePinningJobData(data);
        await mirrorArtifactClosure(client, validated.cid, validated.metadataCids ?? [], config);
      },
    },
  ];
}

export function startPinningWorker(
  queue: Queue,
  config: ArtifactWorkerConfig,
  client: ArtifactFacadeClient,
  workerOptions?: WorkerOptions
) {
  return queue.createWorker(createPinningHandlers(client, config), workerOptions);
}
