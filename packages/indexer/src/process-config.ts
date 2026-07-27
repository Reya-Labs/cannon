import { CleanedEnv, CleanedEnvAccessors, cleanEnv, str } from 'envalid';
import 'dotenv/config';

export const INDEXER_PROCESS_MODES = ['combined', 'registry', 'artifact-worker'] as const;
export type IndexerProcessMode = (typeof INDEXER_PROCESS_MODES)[number];

const processConfigSpecs = {
  INDEXER_PROCESS_MODE: str({
    choices: [...INDEXER_PROCESS_MODES],
    default: 'combined',
  }),
};

export type IndexerProcessConfig = Omit<CleanedEnv<typeof processConfigSpecs>, keyof CleanedEnvAccessors> & {
  INDEXER_PROCESS_MODE: IndexerProcessMode;
};

export function loadIndexerProcessConfig(environment: unknown = process.env): IndexerProcessConfig {
  return cleanEnv(environment, processConfigSpecs) as IndexerProcessConfig;
}
