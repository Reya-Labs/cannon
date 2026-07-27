import { loadIndexerProcessConfig } from './process-config';
import { runIndexerProcess } from './process-mode';

export * from './db';

if (require.main === module) {
  const { INDEXER_PROCESS_MODE } = loadIndexerProcessConfig(process.env);
  void runIndexerProcess(INDEXER_PROCESS_MODE).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`indexer ${INDEXER_PROCESS_MODE} process failed`, err);
    process.exit(1);
  });
}
