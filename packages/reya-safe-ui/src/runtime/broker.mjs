import {
  COMMIT_PATTERN,
  decodePreviewRequest,
  PREVIEW_BROKER_LIMITS,
  PREVIEW_PROTOCOL_VERSION,
  preparePreviewResult,
  validateRunId,
} from './protocol.mjs';

const HANDLER_KEYS = Object.freeze([
  'artifactCat',
  'rpcRead',
  'sourceBundle',
]);

function exactHandlerKeys(handlers) {
  if (
    handlers === null ||
    typeof handlers !== 'object' ||
    Array.isArray(handlers)
  ) {
    return false;
  }
  const keys = Reflect.ownKeys(handlers);
  return (
    keys.length === HANDLER_KEYS.length &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        HANDLER_KEYS.includes(key) &&
        typeof handlers[key] === 'function'
    )
  );
}

function validateLimits(limits) {
  const expected = Reflect.ownKeys(PREVIEW_BROKER_LIMITS);
  if (
    limits === null ||
    typeof limits !== 'object' ||
    Array.isArray(limits) ||
    Reflect.ownKeys(limits).length !== expected.length ||
    expected.some(
      (key) =>
        !Object.hasOwn(limits, key) ||
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > PREVIEW_BROKER_LIMITS[key]
    )
  ) {
    throw new Error('preview broker limits are invalid');
  }
  return Object.freeze({ ...limits });
}

function resultLimit(operation, limits) {
  if (operation === 'artifactCat') return limits.artifactBytes;
  if (operation === 'sourceBundle') return limits.sourceResultBytes;
  return limits.rpcResultBytes;
}

/**
 * Creates the only main-document bridge available to a disposable simulator.
 *
 * The worker can request three semantic reads. It cannot choose a URL, supply
 * credentials, transfer a MessagePort, stage a Safe transaction, or persist
 * data. Any framing, budget, handler, or worker failure closes the entire run.
 *
 * @param {{
 *   expectedCommit: string,
 *   handlers: {
 *     artifactCat: Function,
 *     rpcRead: Function,
 *     sourceBundle: Function,
 *   },
 *   limits?: typeof PREVIEW_BROKER_LIMITS,
 *   runId: string,
 *   worker: Worker,
 * }} options
 * @returns {{close: Function, readonly closed: boolean}}
 */
export function createPreviewBroker({
  expectedCommit,
  handlers,
  limits = PREVIEW_BROKER_LIMITS,
  runId,
  worker,
}) {
  validateRunId(runId);
  if (
    typeof expectedCommit !== 'string' ||
    !COMMIT_PATTERN.test(expectedCommit)
  ) {
    throw new Error('preview broker commit is invalid');
  }
  if (!exactHandlerKeys(handlers)) {
    throw new Error('preview broker handlers are invalid');
  }
  if (
    worker === null ||
    typeof worker !== 'object' ||
    typeof worker.addEventListener !== 'function' ||
    typeof worker.removeEventListener !== 'function' ||
    typeof worker.postMessage !== 'function' ||
    typeof worker.terminate !== 'function'
  ) {
    throw new Error('preview broker worker is invalid');
  }
  const bounded = validateLimits(limits);
  const boundedHandlers = Object.freeze(
    Object.fromEntries(HANDLER_KEYS.map((key) => [key, handlers[key]]))
  );
  const pending = new Map();
  let active = 0;
  let closed = false;
  let expectedId = 1;
  let requests = 0;
  let resultBytes = 0;

  const terminate = () => {
    if (closed) return;
    closed = true;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onWorkerFailure);
    worker.removeEventListener('messageerror', onWorkerFailure);
    for (const [controller, timeout] of pending) {
      clearTimeout(timeout);
      controller.abort();
    }
    pending.clear();
    try {
      worker.terminate();
    } catch {
      // The browser isolation boundary has already been closed.
    }
  };

  const post = (message) => {
    if (closed) return false;
    try {
      worker.postMessage(
        Object.freeze({
          runId,
          version: PREVIEW_PROTOCOL_VERSION,
          ...message,
        })
      );
      return true;
    } catch {
      terminate();
      return false;
    }
  };

  const run = async (request) => {
    active += 1;
    const controller = new AbortController();
    let timeout;
    try {
      const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('preview broker request timed out'));
        }, bounded.requestTimeoutMs);
      });
      pending.set(controller, timeout);
      const result = await Promise.race([
        boundedHandlers[request.operation](request.input, {
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (closed) return;
      const prepared = preparePreviewResult(
        request.operation,
        result,
        bounded
      );
      if (
        prepared.bytes > resultLimit(request.operation, bounded) ||
        resultBytes + prepared.bytes > bounded.resultBytes
      ) {
        throw new Error('preview broker result exceeds byte limits');
      }
      resultBytes += prepared.bytes;
      post({
        id: request.id,
        result: prepared.value,
        type: 'result',
      });
    } catch {
      if (closed) return;
      post({
        error: 'PREVIEW_READ_FAILED',
        id: request.id,
        type: 'error',
      });
      terminate();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      pending.delete(controller);
      active -= 1;
    }
  };

  function onMessage(event) {
    if (closed) return;
    try {
      if (
        event === null ||
        typeof event !== 'object' ||
        !Array.isArray(event.ports) ||
        event.ports.length !== 0 ||
        active >= bounded.concurrentRequests ||
        requests >= bounded.requestCount
      ) {
        throw new Error('preview broker event is invalid');
      }
      const request = decodePreviewRequest(event.data, {
        expectedCommit,
        expectedId,
        limits: bounded,
        runId,
      });
      expectedId += 1;
      requests += 1;
      void run(request);
    } catch {
      terminate();
    }
  }

  function onWorkerFailure() {
    terminate();
  }

  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onWorkerFailure);
  worker.addEventListener('messageerror', onWorkerFailure);
  if (!post({ type: 'ready' })) {
    throw new Error('preview broker worker initialization failed');
  }

  return Object.freeze({
    close: terminate,
    get closed() {
      return closed;
    },
  });
}
