import { createArtifactClient } from './artifacts.mjs';
import { REYA_CHAIN_ID, validateReadClientOptions } from './config.mjs';
import { createQueryClient } from './query.mjs';
import { createRpcClient } from './rpc.mjs';
import { createSourceClient } from './source.mjs';

export { ARTIFACT_CAT_PATH } from './artifacts.mjs';
export { REYA_CHAIN_ID, REYA_READ_LIMITS } from './config.mjs';
export { ReyaReadClientError } from './errors.mjs';
export { QUERY_ROUTE_PATHS } from './query.mjs';
export { RPC_ROUTE_PATH } from './rpc.mjs';
export {
  createReyaSafeSigningClient,
  SAFE_TX_TYPES,
} from './safe-signing.mjs';
export {
  createReyaStagingClient,
  REYA_STAGING_LIMITS,
  STAGING_ROUTE_PREFIX,
} from './staging.mjs';
export { ReyaStagingServiceError } from './errors.mjs';
export {
  SOURCE_REPOSITORY,
  SOURCE_ROOT,
  SOURCE_ROUTE_PREFIX,
} from './source.mjs';

export function createReyaReadOnlyClients(options) {
  const config = validateReadClientOptions(options);
  return Object.freeze({
    artifacts: createArtifactClient(config),
    chainId: REYA_CHAIN_ID,
    query: createQueryClient(config),
    rpc: createRpcClient(config),
    serviceOrigin: config.serviceOrigin,
    source: createSourceClient(config),
  });
}
