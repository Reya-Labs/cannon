import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createPreviewBroker } from '../src/runtime/broker.mjs';
import {
  PREVIEW_BROKER_LIMITS,
  PREVIEW_PROTOCOL_VERSION,
} from '../src/runtime/protocol.mjs';

const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';
const RUN_ID = '01234567-89ab-4cde-8fab-0123456789ab';
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminations = 0;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(data, ports = []) {
    this.emitEvent('message', { data, ports });
  }

  emitEvent(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  postMessage(message) {
    this.messages.push(message);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  terminate() {
    this.terminations += 1;
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0
    );
  }
}

function request(id, operation, input, overrides = {}) {
  return {
    version: PREVIEW_PROTOCOL_VERSION,
    type: 'request',
    runId: RUN_ID,
    id,
    operation,
    input,
    ...overrides,
  };
}

function handlers(overrides = {}) {
  return {
    artifactCat: async ({ cid }) => new TextEncoder().encode(cid),
    rpcRead: async ({ method }) => ({ method, result: '0x6c1' }),
    sourceBundle: async ({ commit }) => ({ commit }),
    ...overrides,
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('serves only the three semantic read operations with monotonic IDs', async () => {
  const worker = new FakeWorker();
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers(),
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
  await settle();
  worker.emit(request(2, 'artifactCat', { cid: CID }));
  await settle();
  worker.emit(
    request(3, 'rpcRead', {
      method: 'eth_chainId',
      params: [],
    })
  );
  await settle();

  assert.equal(worker.messages[0].type, 'ready');
  assert.deepEqual(
    worker.messages.slice(1).map(({ id, type }) => ({ id, type })),
    [
      { id: 1, type: 'result' },
      { id: 2, type: 'result' },
      { id: 3, type: 'result' },
    ]
  );
  assert.equal(worker.terminations, 0);
  assert.equal(broker.closed, false);
  broker.close();
  assert.equal(worker.terminations, 1);
  assert.equal(worker.listenerCount, 0);
});

test('snapshots handler references and clones every posted result', async () => {
  const worker = new FakeWorker();
  const artifact = new Uint8Array([1, 2, 3]);
  const source = { commit: COMMIT, files: ['one.toml'] };
  const mutableHandlers = handlers({
    artifactCat: async () => artifact,
    sourceBundle: async () => source,
  });
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: mutableHandlers,
    runId: RUN_ID,
    worker,
  });
  mutableHandlers.sourceBundle = async () => ({ replaced: true });

  worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
  await settle();
  source.files[0] = 'mutated.toml';
  worker.emit(request(2, 'artifactCat', { cid: CID }));
  await settle();
  artifact[0] = 255;

  assert.deepEqual(worker.messages[1].result, {
    commit: COMMIT,
    files: ['one.toml'],
  });
  assert.deepEqual(worker.messages[2].result, new Uint8Array([1, 2, 3]));
  broker.close();
});

for (const [name, mutate, ports = []] of [
  ['wrong run', (value) => ({ ...value, runId: crypto.randomUUID() })],
  ['wrong version', (value) => ({ ...value, version: 2 })],
  ['unknown operation', (value) => ({ ...value, operation: 'fetch' })],
  ['extra field', (value) => ({ ...value, url: 'blocked' })],
  ['non-monotonic ID', (value) => ({ ...value, id: 2 })],
  ['wrong source commit', (value) => ({ ...value, input: { commit: '0'.repeat(40) } })],
  ['forbidden RPC method', (value) => ({ ...value, input: { method: 'eth_sendTransaction', params: [] } })],
  ['message port', (value) => value, [{}]],
]) {
  test(`terminates on ${name} without invoking a handler`, async () => {
    const worker = new FakeWorker();
    let calls = 0;
    const broker = createPreviewBroker({
      expectedCommit: COMMIT,
      handlers: handlers({
        sourceBundle: async () => {
          calls += 1;
          return {};
        },
      }),
      runId: RUN_ID,
      worker,
    });

    worker.emit(
      mutate(request(1, 'sourceBundle', { commit: COMMIT })),
      ports
    );
    await settle();

    assert.equal(calls, 0);
    assert.equal(worker.terminations, 1);
    assert.equal(broker.closed, true);
  });
}

test('terminates on a replay after the first request', async () => {
  const worker = new FakeWorker();
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers(),
    runId: RUN_ID,
    worker,
  });
  const first = request(1, 'sourceBundle', { commit: COMMIT });

  worker.emit(first);
  await settle();
  worker.emit(first);
  await settle();

  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('caps concurrent work and aborts every active request on violation', async () => {
  const worker = new FakeWorker();
  const signals = [];
  const pending = () =>
    new Promise(() => {
      // Deliberately never settles; broker termination must abort the signal.
    });
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      rpcRead: async (_input, { signal }) => {
        signals.push(signal);
        return pending();
      },
    }),
    runId: RUN_ID,
    worker,
  });

  for (let id = 1; id <= PREVIEW_BROKER_LIMITS.concurrentRequests + 1; id += 1) {
    worker.emit(
      request(id, 'rpcRead', { method: 'eth_chainId', params: [] })
    );
  }
  await settle();

  assert.equal(signals.length, PREVIEW_BROKER_LIMITS.concurrentRequests);
  assert.ok(signals.every(({ aborted }) => aborted));
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('permits only one in-flight artifact read', async () => {
  const worker = new FakeWorker();
  const signals = [];
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      artifactCat: async (_input, { signal }) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    }),
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'artifactCat', { cid: CID }));
  worker.emit(request(2, 'artifactCat', { cid: CID }));
  await settle();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('reserves bounded response memory before starting handlers', async () => {
  const worker = new FakeWorker();
  const signals = [];
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      artifactCat: async (_input, { signal }) => {
        signals.push(signal);
        return new Promise(() => {});
      },
      sourceBundle: async (_input, { signal }) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    }),
    limits: {
      ...PREVIEW_BROKER_LIMITS,
      artifactBytes: 5,
      resultBytes: 6,
      sourceResultBytes: 2,
    },
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'artifactCat', { cid: CID }));
  worker.emit(request(2, 'sourceBundle', { commit: COMMIT }));
  await settle();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('caps aggregate request count and aborts active work', async () => {
  const worker = new FakeWorker();
  const signals = [];
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      rpcRead: async (_input, { signal }) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    }),
    limits: { ...PREVIEW_BROKER_LIMITS, requestCount: 1 },
    runId: RUN_ID,
    worker,
  });

  worker.emit(
    request(1, 'rpcRead', { method: 'eth_chainId', params: [] })
  );
  worker.emit(
    request(2, 'rpcRead', { method: 'eth_chainId', params: [] })
  );
  await settle();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('caps cumulative result bytes and aborts the rejected request', async () => {
  const worker = new FakeWorker();
  const result = { result: '0x1' };
  const resultSize = new TextEncoder().encode(
    JSON.stringify(result)
  ).byteLength;
  const signals = [];
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      rpcRead: async (_input, context) => {
        signals.push(context.signal);
        return result;
      },
    }),
    limits: {
      ...PREVIEW_BROKER_LIMITS,
      rpcResultBytes: resultSize,
      resultBytes: resultSize * 2 - 1,
    },
    runId: RUN_ID,
    worker,
  });

  worker.emit(
    request(1, 'rpcRead', { method: 'eth_chainId', params: [] })
  );
  await settle();
  worker.emit(
    request(2, 'rpcRead', { method: 'eth_chainId', params: [] })
  );
  await settle();

  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ['ready', 'result']
  );
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('sanitizes handler failures, terminates, and ignores late results', async () => {
  const worker = new FakeWorker();
  let resolveLate;
  const late = new Promise((resolve) => {
    resolveLate = resolve;
  });
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      sourceBundle: async () => late,
    }),
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
  broker.close();
  resolveLate({ secret: 'must not be posted' });
  await settle();

  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ['ready']
  );
  assert.equal(worker.terminations, 1);
});

for (const eventType of ['error', 'messageerror']) {
  test(`terminates on a worker ${eventType} event`, () => {
    const worker = new FakeWorker();
    const broker = createPreviewBroker({
      expectedCommit: COMMIT,
      handlers: handlers(),
      runId: RUN_ID,
      worker,
    });

    worker.emitEvent(eventType);

    assert.equal(worker.terminations, 1);
    assert.equal(worker.listenerCount, 0);
    assert.equal(broker.closed, true);
  });
}

test('fails closed when the worker refuses a message', async () => {
  const worker = new FakeWorker();
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      sourceBundle: async () => ({ result: 'sensitive' }),
    }),
    runId: RUN_ID,
    worker,
  });
  worker.postMessage = () => {
    throw new Error('structured clone failure');
  };

  worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
  await settle();

  assert.equal(worker.terminations, 1);
  assert.equal(worker.listenerCount, 0);
  assert.equal(broker.closed, true);
});

test('cleans up and rejects when the initial ready message fails', () => {
  const worker = new FakeWorker();
  worker.postMessage = () => {
    throw new Error('worker unavailable');
  };

  assert.throws(
    () =>
      createPreviewBroker({
        expectedCommit: COMMIT,
        handlers: handlers(),
        runId: RUN_ID,
        worker,
      }),
    /worker initialization failed/
  );
  assert.equal(worker.terminations, 1);
  assert.equal(worker.listenerCount, 0);
});

test('terminates and aborts a timed-out request', async () => {
  const worker = new FakeWorker();
  let signal;
  const limits = { ...PREVIEW_BROKER_LIMITS, requestTimeoutMs: 5 };
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: handlers({
      sourceBundle: async (_input, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    }),
    limits,
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
  await delay(20);

  assert.equal(signal.aborted, true);
  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ['ready', 'error']
  );
  assert.equal(worker.messages[1].error, 'PREVIEW_READ_FAILED');
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('rejects deep, non-JSON, and oversized RPC inputs before the handler', async () => {
  for (const params of [
    [new Uint8Array([1])],
    ['x'.repeat(PREVIEW_BROKER_LIMITS.inputBytes + 1)],
    [[[[[[[[[[[[[true]]]]]]]]]]]]],
    Object.assign([], { unexpected: true }),
  ]) {
    const worker = new FakeWorker();
    let calls = 0;
    const broker = createPreviewBroker({
      expectedCommit: COMMIT,
      handlers: handlers({
        rpcRead: async () => {
          calls += 1;
          return {};
        },
      }),
      runId: RUN_ID,
      worker,
    });

    worker.emit(
      request(1, 'rpcRead', {
        method: 'eth_call',
        params,
      })
    );
    await settle();

    assert.equal(calls, 0);
    assert.equal(worker.terminations, 1);
    assert.equal(broker.closed, true);
  }
});

test('rejects non-JSON and structurally hostile handler results', async () => {
  const forbidden = Object.create(null);
  forbidden.__proto__ = { polluted: true };
  const sparse = [];
  sparse[1] = 'hole';

  for (const result of [
    { value: undefined },
    forbidden,
    sparse,
    new Date(),
  ]) {
    const worker = new FakeWorker();
    const broker = createPreviewBroker({
      expectedCommit: COMMIT,
      handlers: handlers({
        sourceBundle: async () => result,
      }),
      runId: RUN_ID,
      worker,
    });

    worker.emit(request(1, 'sourceBundle', { commit: COMMIT }));
    await settle();

    assert.equal(worker.messages.at(-1).type, 'error');
    assert.equal(worker.terminations, 1);
    assert.equal(broker.closed, true);
  }
});

test('terminates when a handler returns a malformed or oversized result', async () => {
  for (const [result, limits] of [
    [1n, PREVIEW_BROKER_LIMITS],
    [
      new Uint8Array(17),
      { ...PREVIEW_BROKER_LIMITS, artifactBytes: 16 },
    ],
  ]) {
    const worker = new FakeWorker();
    const broker = createPreviewBroker({
      expectedCommit: COMMIT,
      handlers: handlers({
        artifactCat: async () => result,
      }),
      limits,
      runId: RUN_ID,
      worker,
    });

    worker.emit(request(1, 'artifactCat', { cid: CID }));
    await settle();

    assert.equal(worker.messages.at(-1).type, 'error');
    assert.equal(worker.messages.at(-1).error, 'PREVIEW_READ_FAILED');
    assert.equal(worker.terminations, 1);
    assert.equal(broker.closed, true);
  }
});
