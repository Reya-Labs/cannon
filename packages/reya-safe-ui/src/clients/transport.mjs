import { REYA_READ_LIMITS } from './config.mjs';
import { fail, ReyaReadClientError } from './errors.mjs';

const TIMEOUT = Symbol('read-client-timeout');
const CANCELLED_BODIES = new WeakSet();

function startDeadline(milliseconds) {
  const controller = new AbortController();
  let expired = false;
  let timeoutId;

  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      controller.abort();
      reject(TIMEOUT);
    }, milliseconds);
  });

  return Object.freeze({
    controller,
    get expired() {
      return expired;
    },
    finish() {
      clearTimeout(timeoutId);
    },
    race(promise) {
      return Promise.race([promise, timeout]);
    },
  });
}

function parseContentLength(headers, maximumBytes) {
  const value = headers.get('content-length');
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail('RESPONSE_REJECTED');

  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    fail('RESPONSE_REJECTED');
  }
  return length;
}

function cancelBody(response) {
  const body = response?.body;
  if (body === null || typeof body !== 'object' || CANCELLED_BODIES.has(body)) {
    return;
  }
  CANCELLED_BODIES.add(body);
  try {
    Promise.resolve(body.cancel()).catch(() => undefined);
  } catch {
    // Cancellation is best effort after the response has already failed closed.
  }
}

function concatenate(chunks, length) {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBody(response, maximumBytes, deadline) {
  parseContentLength(response.headers, maximumBytes);
  if (
    response.body === null ||
    typeof response.body?.getReader !== 'function'
  ) {
    fail('RESPONSE_REJECTED');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let chunkCount = 0;
  let length = 0;
  let completed = false;

  try {
    while (true) {
      const result = await deadline.race(reader.read());
      if (
        result === null ||
        typeof result !== 'object' ||
        typeof result.done !== 'boolean'
      ) {
        fail('RESPONSE_REJECTED');
      }
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        fail('RESPONSE_REJECTED');
      }

      chunkCount += 1;
      if (chunkCount > REYA_READ_LIMITS.responseChunks) {
        fail('RESPONSE_REJECTED');
      }
      length += result.value.byteLength;
      if (length > maximumBytes) fail('RESPONSE_REJECTED');
      chunks.push(result.value);
    }
  } finally {
    if (!completed) {
      deadline.controller.abort();
      CANCELLED_BODIES.add(response.body);
      try {
        Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        // Cancellation is best effort after the response has already failed closed.
      }
    }
    reader.releaseLock();
  }

  return concatenate(chunks, length);
}

function validateContentType(headers, expected) {
  const value = headers.get('content-type');
  if (typeof value !== 'string') fail('RESPONSE_REJECTED');
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== expected) fail('RESPONSE_REJECTED');
}

export async function boundedRequest({
  accept,
  body,
  contentType,
  deadlineMs,
  fetchImpl,
  maximumBytes,
  method,
  responseMediaType,
  url,
}) {
  const deadline = startDeadline(deadlineMs);
  let response;
  let bodyReadCompleted = false;

  try {
    const headers = { Accept: accept };
    if (contentType !== undefined) headers['Content-Type'] = contentType;
    const request = {
      cache: 'no-store',
      credentials: 'omit',
      headers: Object.freeze(headers),
      method,
      mode: 'cors',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: deadline.controller.signal,
    };
    if (body !== undefined) request.body = body;
    response = await deadline.race(
      fetchImpl(url, Object.freeze(request))
    );

    if (
      response === null ||
      typeof response !== 'object' ||
      response.redirected !== false ||
      response.status !== 200 ||
      typeof response.headers?.get !== 'function'
    ) {
      fail('REQUEST_FAILED');
    }

    validateContentType(response.headers, responseMediaType);
    const bytes = await readBody(response, maximumBytes, deadline);
    bodyReadCompleted = true;
    return bytes;
  } catch (error) {
    if (!bodyReadCompleted) cancelBody(response);
    if (error === TIMEOUT || deadline.expired) fail('REQUEST_TIMEOUT');
    if (error instanceof ReyaReadClientError) throw error;
    fail('REQUEST_FAILED');
  } finally {
    deadline.finish();
  }
}

export function parseJson(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    fail('RESPONSE_REJECTED');
  }
}
