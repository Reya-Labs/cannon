import {
  ARTIFACT_CAT_PATH,
  createReyaReadOnlyClients,
  OP_REGISTRY_RESOLVE_PATH,
  RPC_ROUTE_PATH,
  SOURCE_ROUTE_PREFIX,
} from '@reya/cannon-safe-ui/read-only';
import { getContentCID } from '@usecannon/artifact-codec';
import { keccak256, stringToHex } from 'viem';
import { ReyaLocalProfileConfig } from './profile-config';

const VIRTUAL_SERVICE_ORIGIN = 'https://cannon-api.reya-local.ts.net';
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SOURCE_ROUTE_SUFFIX = '/reya-network';
const PREVIEW_PATH = '/preview/1729';
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const EXACT_READ_PATHS: ReadonlySet<string> = new Set([OP_REGISTRY_RESOLVE_PATH, PREVIEW_PATH, RPC_ROUTE_PATH]);

function allowedSourcePath(pathname: string): boolean {
  if (!pathname.startsWith(SOURCE_ROUTE_PREFIX) || !pathname.endsWith(SOURCE_ROUTE_SUFFIX)) {
    return false;
  }
  const commit = pathname.slice(SOURCE_ROUTE_PREFIX.length, -SOURCE_ROUTE_SUFFIX.length);
  return COMMIT_PATTERN.test(commit);
}

function allowedVirtualUrl(url: URL): boolean {
  if (url.origin !== VIRTUAL_SERVICE_ORIGIN || url.username !== '' || url.password !== '' || url.hash !== '') {
    return false;
  }
  if (url.pathname === ARTIFACT_CAT_PATH) {
    const keys = [...url.searchParams.keys()];
    const cid = url.searchParams.get('arg');
    return keys.length === 1 && keys[0] === 'arg' && cid !== null && CID_PATTERN.test(cid) && url.search === `?arg=${cid}`;
  }
  return url.search === '' && (EXACT_READ_PATHS.has(url.pathname) || allowedSourcePath(url.pathname));
}

async function boundedResponseText(response: Response, declaredBytes: number): Promise<string> {
  if (response.body === null) {
    throw new Error('AUTOMATIC_PREVIEW_FAILED');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > declaredBytes || length > MAX_PREVIEW_BYTES) {
      await reader.cancel();
      throw new Error('AUTOMATIC_PREVIEW_FAILED');
    }
    chunks.push(part.value);
  }
  if (length !== declaredBytes) {
    throw new Error('AUTOMATIC_PREVIEW_FAILED');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('AUTOMATIC_PREVIEW_FAILED');
  }
}

/**
 * Creates a transport that rewrites only the declared virtual service
 * routes to the fixed local ingress. No caller-controlled host is forwarded.
 */
export function createLoopbackFetch(ingressOrigin: string): typeof fetch {
  return async (input, init) => {
    const virtual = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!allowedVirtualUrl(virtual)) {
      throw new Error('Reya local client route is not allowed');
    }
    const target = new URL(ingressOrigin);
    target.pathname = virtual.pathname;
    target.search = virtual.search;
    return fetch(target, init);
  };
}

/**
 * Verifies that an ABI function signature hashes to the supplied selector.
 */
export function verifyAbiSelector(signature: string, selector: string): boolean {
  if (typeof signature !== 'string' || typeof selector !== 'string') {
    return false;
  }
  try {
    return keccak256(stringToHex(signature)).slice(0, 10).toLowerCase() === selector.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Creates the constrained clients for the local Reya profile.
 *
 * Read-only RPC, pinned source, OP-registry, and artifact routes are mapped
 * from a non-routable virtual origin to the fixed loopback ingress. Artifact
 * bytes are content-address verified in the browser. The returned client set
 * exposes no wallet-signing or staging transport.
 */
export function createReyaLocalClients(config: ReyaLocalProfileConfig) {
  const fetchImpl = createLoopbackFetch(config.ingressOrigin);
  const read = createReyaReadOnlyClients({
    fetchImpl,
    serviceOrigin: VIRTUAL_SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: (bytes: Uint8Array) => getContentCID(bytes),
  });
  return Object.freeze({
    preview: Object.freeze({
      async generate(input: {
        commit: string;
        partialDeployCid: string | null;
        previousPackageCid: string;
      }): Promise<string> {
        const response = await fetchImpl(`${VIRTUAL_SERVICE_ORIGIN}${PREVIEW_PATH}`, {
          body: JSON.stringify({
            chainId: 1729,
            commit: input.commit,
            partialDeployCid: input.partialDeployCid,
            previousPackageCid: input.previousPackageCid,
            safeAddress: config.safeAddress,
          }),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10 * 60_000),
        });
        const declared = response.headers.get('content-length');
        if (
          response.status !== 200 ||
          response.redirected ||
          response.headers.get('content-type')?.split(';', 1)[0].trim() !== 'application/json' ||
          declared === null ||
          !/^(?:0|[1-9][0-9]*)$/.test(declared) ||
          Number(declared) < 2 ||
          Number(declared) > MAX_PREVIEW_BYTES
        ) {
          await response.body?.cancel();
          throw new Error(response.status === 409 ? 'PREVIEW_ALREADY_RUNNING' : 'AUTOMATIC_PREVIEW_FAILED');
        }
        return boundedResponseText(response, Number(declared));
      },
    }),
    read,
  });
}
