import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReyaReadOnlyClients,
} from '../src/clients/index.mjs';
import { createPreviewBroker } from '../src/runtime/broker.mjs';
import {
  PREVIEW_BROKER_LIMITS,
  PREVIEW_PROTOCOL_VERSION,
} from '../src/runtime/protocol.mjs';
import {
  DEPLOY_CID,
  SERVICE_ORIGIN,
  verifyAbiSelector,
} from '../test-support/client-fixtures.mjs';

const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';
const RUN_ID = '01234567-89ab-4cde-8fab-0123456789ab';

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

  emit(data) {
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      listener({ data, ports: [] });
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
}

function request(id, operation, input) {
  return {
    id,
    input,
    operation,
    runId: RUN_ID,
    type: 'request',
    version: PREVIEW_PROTOCOL_VERSION,
  };
}

function deferredTransport() {
  const requests = [];
  return {
    fetchImpl(url, options) {
      let resolve;
      const response = new Promise((settle) => {
        resolve = settle;
      });
      requests.push({ options, resolve, url });
      return response;
    },
    requests,
  };
}

function clientsFor(fetchImpl) {
  return createReyaReadOnlyClients({
    fetchImpl,
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async () => DEPLOY_CID,
  });
}

function brokerHandlers(clients) {
  return {
    artifactCat: (input, context) => clients.artifacts.cat(input, context),
    rpcRead: (input, context) => clients.rpc.read(input, context),
    sourceBundle: (input, context) => clients.source.bundle(input, context),
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('broker close aborts the exact real-client fetch and suppresses a late response', async () => {
  const transport = deferredTransport();
  const worker = new FakeWorker();
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: brokerHandlers(clientsFor(transport.fetchImpl)),
    runId: RUN_ID,
    worker,
  });

  worker.emit(request(1, 'artifactCat', { cid: DEPLOY_CID }));
  await settle();
  assert.equal(transport.requests.length, 1);
  const [{ options, resolve }] = transport.requests;
  assert.equal(options.signal.aborted, false);

  broker.close();
  assert.equal(options.signal.aborted, true);
  resolve(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'application/octet-stream' },
      status: 200,
    })
  );
  await settle();
  await settle();

  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ['ready']
  );
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});

test('concurrency rejection aborts the active real-client fetch and suppresses its late response', async () => {
  const transport = deferredTransport();
  const worker = new FakeWorker();
  const broker = createPreviewBroker({
    expectedCommit: COMMIT,
    handlers: brokerHandlers(clientsFor(transport.fetchImpl)),
    limits: {
      ...PREVIEW_BROKER_LIMITS,
      concurrentRequests: 1,
    },
    runId: RUN_ID,
    worker,
  });

  worker.emit(
    request(1, 'rpcRead', { method: 'eth_chainId', params: [] })
  );
  await settle();
  assert.equal(transport.requests.length, 1);
  const [{ options, resolve }] = transport.requests;
  assert.equal(options.signal.aborted, false);

  worker.emit(request(2, 'sourceBundle', { commit: COMMIT }));
  assert.equal(options.signal.aborted, true);
  assert.equal(transport.requests.length, 1);
  resolve(
    new Response('{"id":1,"jsonrpc":"2.0","result":"0x6c1"}', {
      headers: { 'content-type': 'application/json' },
      status: 200,
    })
  );
  await settle();
  await settle();

  assert.deepEqual(
    worker.messages.map(({ type }) => type),
    ['ready']
  );
  assert.equal(worker.terminations, 1);
  assert.equal(broker.closed, true);
});
