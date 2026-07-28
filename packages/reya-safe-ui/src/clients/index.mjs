import { createArtifactClient } from './artifacts.mjs';
import { REYA_CHAIN_ID, validateReadClientOptions } from './config.mjs';
import { createQueryClient } from './query.mjs';

export { ARTIFACT_CAT_PATH } from './artifacts.mjs';
export { REYA_CHAIN_ID, REYA_READ_LIMITS } from './config.mjs';
export { ReyaReadClientError } from './errors.mjs';
export { QUERY_ROUTE_PATHS } from './query.mjs';

export function createReyaReadOnlyClients(options) {
  const config = validateReadClientOptions(options);
  return Object.freeze({
    artifacts: createArtifactClient(config),
    chainId: REYA_CHAIN_ID,
    query: createQueryClient(config),
    serviceOrigin: config.serviceOrigin,
  });
}
