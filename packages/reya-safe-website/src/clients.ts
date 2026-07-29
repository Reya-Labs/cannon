import {
  createReyaReadOnlyClients,
  createReyaSafeSigningClient,
  createReyaStagingClient,
} from '@reya/cannon-safe-ui/clients';
import { keccak256, stringToHex } from 'viem';
import { ReyaLocalProfileConfig } from './profile-config';

const VIRTUAL_SERVICE_ORIGIN = 'https://cannon-api.reya-local.ts.net';
const ALLOWED_PATHS = Object.freeze([
  /^\/rpc\/1729$/,
  /^\/source\/reya-deployments\/[0-9a-f]{40}\/reya-network$/,
  /^\/staging\/1729\/0x[0-9a-f]{40}$/,
]);

function createLoopbackFetch(ingressOrigin: string): typeof fetch {
  return async (input, init) => {
    const virtual = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (virtual.origin !== VIRTUAL_SERVICE_ORIGIN || !ALLOWED_PATHS.some((pattern) => pattern.test(virtual.pathname))) {
      throw new Error('Reya local client route is not allowed');
    }
    const target = new URL(ingressOrigin);
    target.pathname = virtual.pathname;
    target.search = virtual.search;
    return fetch(target, init);
  };
}

function verifyAbiSelector(signature: string, selector: string): boolean {
  if (typeof signature !== 'string' || typeof selector !== 'string') {
    return false;
  }
  try {
    return keccak256(stringToHex(signature)).slice(0, 10).toLowerCase() === selector.toLowerCase();
  } catch {
    return false;
  }
}

export function createReyaLocalClients(config: ReyaLocalProfileConfig) {
  const fetchImpl = createLoopbackFetch(config.ingressOrigin);
  const read = createReyaReadOnlyClients({
    fetchImpl,
    serviceOrigin: VIRTUAL_SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: () => {
      throw new Error('ARTIFACT_ROUTE_DISABLED');
    },
  });
  const staging = createReyaStagingClient({
    fetchImpl,
    safeAddress: config.safeAddress,
    serviceOrigin: VIRTUAL_SERVICE_ORIGIN,
  });

  return Object.freeze({
    read,
    signing: (signTypedData: (value: unknown) => Promise<string>) =>
      createReyaSafeSigningClient({
        safeAddress: config.safeAddress,
        signTypedData,
      }),
    staging,
  });
}
