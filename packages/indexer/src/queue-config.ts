import { CleanedEnv, CleanedEnvAccessors, cleanEnv, num, str } from 'envalid';
import 'dotenv/config';

const queueConfigSpecs = {
  REDIS_URL: str({ devDefault: 'redis://localhost:6379' }),
  QUEUE_NAME: str({ default: 'pinner-queue' }),
  QUEUE_CONCURRENCY: num({ default: 5 }),
  QUEUE_RETRIES: num({ default: 5 }),
};

export type QueueConfig = Omit<CleanedEnv<typeof queueConfigSpecs>, keyof CleanedEnvAccessors>;

export function loadQueueConfig(environment: unknown = process.env): QueueConfig {
  return cleanEnv(environment, queueConfigSpecs) as QueueConfig;
}
