import { createQueue as createQueueHelper } from '../helpers/create-queue';
import type { QueueConfig } from '../queue-config';
import { pinningJobContracts } from './contracts';

export type Queue = ReturnType<typeof createQueue>;

export function createQueue(config: QueueConfig) {
  return createQueueHelper(pinningJobContracts, {
    redisUrl: config.REDIS_URL,
    queueName: config.QUEUE_NAME,
    retries: config.QUEUE_RETRIES,
    defaultConcurrency: config.QUEUE_CONCURRENCY,
  });
}
