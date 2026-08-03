import { PreviewError } from '../errors.mjs';
import { boundedUpstreamRequest } from './upstream.mjs';

export const ARTIFACT_CAT_PATH = '/artifacts/api/v0/cat';
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const ARTIFACT_TIMEOUT_MS = 60_000;
export const MAX_ARTIFACT_READS = 2_048;

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

function reject() {
  throw new PreviewError(502, 'PREVIEW_FAILED');
}

/**
 * Reads immutable Cannon artifacts from the GCS-backed, Kubo-compatible
 * facade.
 *
 * Every response is verified against the CID that was requested before it is
 * handed to the builder. That check is what makes the facade untrusted
 * infrastructure rather than a trusted party: a substituted artifact does not
 * reach the definition, the deployment state or the simulated calls. There is
 * no hosted Cannon, Pinata or public IPFS fallback — a miss is a failure.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   getContentCid: (bytes: Uint8Array) => Promise<string>,
 *   maximumBytes?: number,
 *   origin: string,
 * }} options
 */
export function createArtifactReader({
  fetchImpl,
  getContentCid,
  maximumBytes = MAX_ARTIFACT_BYTES,
  origin,
}) {
  if (
    typeof origin !== 'string' ||
    origin.length < 1 ||
    typeof getContentCid !== 'function' ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new Error('preview artifact reader configuration is invalid');
  }
  let reads = 0;

  return Object.freeze({
    get reads() {
      return reads;
    },
    /**
     * @param {string} cid
     * @param {{signal?: AbortSignal}} [context]
     * @returns {Promise<Uint8Array>}
     */
    async read(cid, { signal } = {}) {
      if (typeof cid !== 'string' || !CID_PATTERN.test(cid)) {
        throw new Error('preview artifact CID is invalid');
      }
      // One preview must not be able to walk the whole artifact store: the
      // read budget bounds a definition that imports in a cycle or explodes.
      reads += 1;
      if (reads > MAX_ARTIFACT_READS) reject();

      const url = new URL(origin);
      url.pathname = ARTIFACT_CAT_PATH;
      url.searchParams.set('arg', cid);

      const bytes = await boundedUpstreamRequest({
        accept: 'application/octet-stream',
        fetchImpl,
        maximumBytes,
        method: 'POST',
        signal,
        timeoutMs: ARTIFACT_TIMEOUT_MS,
        url: url.href,
      });
      if (bytes.byteLength < 1) reject();

      let computed;
      try {
        computed = await getContentCid(bytes.slice());
      } catch {
        reject();
      }
      if (typeof computed !== 'string' || computed !== cid) reject();
      return bytes;
    },
  });
}
