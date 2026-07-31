import { PreviewError } from './errors.mjs';

const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 4_096;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * JSON-RPC error codes an archive-backed node returns when the requested
 * historical state has been pruned. The available Reya RPC is not archival, so
 * these must surface as an explicit fail-closed contract rather than being
 * retried against `latest`.
 */
const PRUNED_STATE_CODES = Object.freeze([-32000, -32001, -32002]);
const PRUNED_STATE_MARKERS = Object.freeze([
  'missing trie node',
  'no historical state',
  'not available historically',
  'state at block',
  'state is not available',
  'pruned',
]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

async function boundedBody(response) {
  if (response.body === null) {
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body.cancel();
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    if (chunks.length >= MAX_RESPONSE_CHUNKS) {
      throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
    }
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

/**
 * Recognises a pruned-state rejection so a reproducibility request fails with
 * `RPC_PINNED_STATE_UNAVAILABLE` instead of silently degrading to current state.
 */
export function isPrunedStateError(error) {
  if (!isPlainObject(error)) return false;
  const message =
    typeof error.message === 'string' ? error.message.toLowerCase() : '';
  return (
    (Number.isSafeInteger(error.code) &&
      PRUNED_STATE_CODES.includes(error.code) &&
      PRUNED_STATE_MARKERS.some((marker) => message.includes(marker))) ||
    PRUNED_STATE_MARKERS.some((marker) => message.includes(marker))
  );
}

/**
 * Performs one bounded, read-only JSON-RPC call against a server-held upstream.
 *
 * The URL and any credential it carries stay in this process: the browser never
 * chooses the endpoint, and no upstream error text is propagated outward.
 *
 * @param {{fetchImpl?: typeof fetch, method: string, params: unknown[], url: string}} options
 */
export async function jsonRpcCall({
  fetchImpl = globalThis.fetch,
  method,
  params,
  url,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get('content-type')?.split(';', 1)[0].trim() !==
      'application/json'
  ) {
    await response.body?.cancel();
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  let body;
  try {
    body = JSON.parse((await boundedBody(response)).toString('utf8'));
  } catch {
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  if (!isPlainObject(body) || body.jsonrpc !== '2.0' || body.id !== 1) {
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  if (Object.hasOwn(body, 'error')) {
    if (isPrunedStateError(body.error)) {
      throw new PreviewError(503, 'RPC_PINNED_STATE_UNAVAILABLE');
    }
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  return body.result;
}

/**
 * Performs one `eth_call` and returns the raw return data.
 *
 * `blockTag` defaults to `latest`. A caller that pins a historical block gets a
 * fail-closed `RPC_PINNED_STATE_UNAVAILABLE` when the non-archival upstream
 * cannot serve it; it never falls back to current state.
 */
export async function ethCall({
  blockTag = 'latest',
  data,
  fetchImpl,
  to,
  url,
}) {
  const result = await jsonRpcCall({
    fetchImpl,
    method: 'eth_call',
    params: [{ data, to }, blockTag],
    url,
  });
  if (typeof result !== 'string' || !HEX_PATTERN.test(result)) {
    throw new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
  }
  return result;
}
