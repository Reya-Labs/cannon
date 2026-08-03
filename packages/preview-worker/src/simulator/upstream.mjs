import { PreviewError } from '../errors.mjs';

const MIN_RESPONSE_CHUNKS = 8_192;
const CHUNK_BUDGET_BYTES = 1_024;

/**
 * The chunk cap bounds iteration, not size — size is already capped by
 * `maximumBytes`. A fixed cap would therefore reject a *valid* response that
 * merely arrived in small pieces: at 8,192 chunks a 50 MiB artifact would have
 * to average 6,400 bytes per chunk, which is a property of the transport, not
 * of the artifact. Deriving the cap from the byte budget keeps the iteration
 * bound without making the transport's framing part of the contract.
 */
function chunkBudget(maximumBytes) {
  return Math.max(
    MIN_RESPONSE_CHUNKS,
    Math.ceil(maximumBytes / CHUNK_BUDGET_BYTES),
  );
}

/**
 * Distinguishes the caller running out of time from the upstream being
 * unusable. Both abort the same fetch, but they are different operational
 * facts: reporting them as one inflates upstream failure counts and hides
 * deadline exhaustion.
 */
function deadlineExceeded() {
  throw new PreviewError(504, 'PREVIEW_FAILED');
}

/**
 * Every cluster-internal upstream failure collapses to one opaque code. The
 * origin, path, status and body of the upstream are never propagated: the
 * browser learns that a dependency was unusable, nothing more.
 */
function unavailable() {
  throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
}

function boundedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal instanceof AbortSignal
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

async function boundedBody(response, maximumBytes) {
  const maximumChunks = chunkBudget(maximumBytes);
  if (response.body === null) unavailable();
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    await response.body.cancel();
    unavailable();
  }
  const chunks = [];
  let length = 0;
  let chunkCount = 0;
  for await (const chunk of response.body) {
    chunkCount += 1;
    if (chunkCount > maximumChunks) unavailable();
    if (!(chunk instanceof Uint8Array)) unavailable();
    length += chunk.byteLength;
    if (length > maximumBytes) unavailable();
    chunks.push(chunk);
  }
  if (declared !== null && length !== Number(declared)) unavailable();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Performs one bounded, read-only request against a cluster-internal upstream.
 *
 * The caller supplies the whole URL; nothing in it is browser-chosen. The
 * response must be an exact `200`, unredirected, of exactly the expected media
 * type, and within both a byte and a chunk budget — so an upstream that has
 * been replaced cannot stream an unbounded body into this process.
 *
 * @param {{
 *   accept: string,
 *   fetchImpl?: typeof fetch,
 *   maximumBytes: number,
 *   method: 'GET' | 'POST',
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   url: string,
 * }} options
 * @returns {Promise<Uint8Array>}
 */
export async function boundedUpstreamRequest({
  accept,
  fetchImpl = globalThis.fetch,
  maximumBytes,
  method,
  signal,
  timeoutMs,
  url,
}) {
  if (
    typeof accept !== 'string' ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !['GET', 'POST'].includes(method) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    typeof url !== 'string'
  ) {
    throw new Error('bounded upstream request options are invalid');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept },
      method,
      redirect: 'error',
      signal: boundedSignal(signal, timeoutMs),
    });
  } catch {
    if (signal?.aborted) deadlineExceeded();
    unavailable();
  }
  if (
    response === null ||
    typeof response !== 'object' ||
    response.status !== 200 ||
    // `!== false`, not `=== true`: a response object that does not report
    // whether it was redirected is not one this process should read.
    response.redirected !== false ||
    typeof response.headers?.get !== 'function' ||
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      .trim()
      .toLowerCase() !== accept
  ) {
    await response?.body?.cancel().catch(() => undefined);
    unavailable();
  }
  return boundedBody(response, maximumBytes);
}
