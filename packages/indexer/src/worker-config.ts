import { CleanedEnv, CleanedEnvAccessors, cleanEnv, EnvError, str } from 'envalid';
import 'dotenv/config';
import { loadQueueConfig } from './queue-config';
import type { QueueConfig } from './queue-config';

const artifactWorkerConfigSpecs = {
  NODE_ENV: str({
    choices: ['development', 'test', 'production', 'staging'],
    default: 'production',
    devDefault: 'development',
  }),
  IPFS_URL: str({ default: '', devDefault: 'http://127.0.0.1:5001' }),
  S3_ENDPOINT: str({ default: '', devDefault: '' }),
  S3_BUCKET: str({ default: '', devDefault: 'cannon' }),
  S3_FOLDER: str({ default: '', devDefault: 'repo-v2' }),
  S3_REGION: str({ default: '', devDefault: 'us-east-1' }),
  S3_KEY: str({ default: '', devDefault: '' }),
  S3_SECRET: str({ default: '', devDefault: '' }),
};

type ArtifactWorkerSpecificConfig = Omit<CleanedEnv<typeof artifactWorkerConfigSpecs>, keyof CleanedEnvAccessors>;

export type ArtifactWorkerConfig = ArtifactWorkerSpecificConfig & QueueConfig;

export function loadArtifactWorkerConfig(environment: unknown = process.env): ArtifactWorkerConfig {
  const config = cleanEnv(environment, artifactWorkerConfigSpecs);
  const productionLike = config.NODE_ENV === 'production' || config.NODE_ENV === 'staging';

  if (productionLike) {
    for (const [name, value] of [
      ['IPFS_URL', config.IPFS_URL],
      ['S3_ENDPOINT', config.S3_ENDPOINT],
      ['S3_BUCKET', config.S3_BUCKET],
      ['S3_FOLDER', config.S3_FOLDER],
      ['S3_REGION', config.S3_REGION],
      ['S3_KEY', config.S3_KEY],
      ['S3_SECRET', config.S3_SECRET],
    ] as const) {
      if (!value.trim()) throw new EnvError(`${name} must be configured explicitly`);
    }
  }

  return Object.freeze({
    ...config,
    ...loadQueueConfig(environment),
  }) as ArtifactWorkerConfig;
}
