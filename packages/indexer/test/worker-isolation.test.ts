/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { compress, getContentCID } from '@usecannon/builder';
import type { ArtifactFacadeClient } from '../src/artifact-client';
import {
  assertExactClosure,
  discoverArtifactClosure,
  mirrorArtifactClosure,
  reconcileClosure,
} from '../src/artifact-closure';
import { createPinningHandlers } from '../src/queue/pinning';
import { createRetryableResourceCloser, listenForShutdown } from '../src/shutdown';
import { startArtifactWorker, waitForArtifactWorkerShutdown } from '../src/worker';
import { PINNING_JOB_CONTRACT_VERSION, pinningJobContracts, validatePinningJobData } from '../src/queue/contracts';
import { loadArtifactWorkerConfig } from '../src/worker-config';
import type { Queue } from '../src/queue';

const TEST_CID = 'QmWPYWDSbBvDu1D2S2mb3vfBT59Z3dMvwaWHKmLfpU6ABC';
const TEST_METADATA_CID = 'QmQjFvZ9WQzVJGJkG9RdRnM8LmC5u3mB7nPK4xEa2HyTuv';

function workerEnvironment(overrides: Record<string, string> = {}) {
  return {
    ARTIFACT_SOURCE_URL: 'http://127.0.0.1:8081',
    ARTIFACT_WRITER_TOKEN: 'test-writer-token',
    ARTIFACT_WRITER_URL: 'http://127.0.0.1:8082',
    NODE_ENV: 'test',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  };
}

function workerConfig(overrides: Record<string, string> = {}) {
  return loadArtifactWorkerConfig(workerEnvironment(overrides));
}

interface MockFacade extends ArtifactFacadeClient {
  reads: string[];
  writes: string[];
  stored: Map<string, Buffer>;
}

function mockFacade(source: Map<string, Buffer>, writerCid?: (cid: string) => string): MockFacade {
  const reads: string[] = [];
  const writes: string[] = [];
  const stored = new Map<string, Buffer>();

  return {
    reads,
    writes,
    stored,
    async checkHealth() {
      return undefined;
    },
    async read(cid) {
      reads.push(cid);
      const data = source.get(cid);
      if (!data) throw new Error('mock source miss');
      return Buffer.from(data);
    },
    async write(cid, data) {
      writes.push(cid);
      const existing = stored.get(cid);
      if (existing && !existing.equals(data)) {
        throw new Error('mock facade immutable-write conflict');
      }
      stored.set(cid, Buffer.from(data));
      return writerCid?.(cid) ?? cid;
    },
  };
}

function deployment(miscCid: string, importCids: string[]) {
  return {
    def: { name: 'test-package', version: '1.0.0' },
    generator: 'cannon test',
    meta: {},
    miscUrl: `ipfs://${miscCid}`,
    options: {},
    state: {
      'deploy.Root': {
        artifacts: {
          imports: Object.fromEntries(
            importCids.map((cid, index) => [`package${index}`, { imports: {}, url: `ipfs://${cid}` }])
          ),
        },
      },
    },
    timestamp: 1,
  };
}

async function compressedArtifact(value: unknown) {
  const data = Buffer.from(compress(JSON.stringify(value)));
  return { cid: await getContentCID(data), data };
}

async function rawArtifact(value: string) {
  const data = Buffer.from(value);
  return { cid: await getContentCID(data), data };
}

async function recursiveFixture() {
  const rootMisc = await rawArtifact('root misc');
  const childMisc = await rawArtifact('child misc');
  const grandchildMisc = await rawArtifact('grandchild misc');
  const metadata = await rawArtifact('on-chain metadata');
  const grandchild = await compressedArtifact(deployment(grandchildMisc.cid, []));
  const child = await compressedArtifact(deployment(childMisc.cid, [grandchild.cid]));
  const root = await compressedArtifact(deployment(rootMisc.cid, [child.cid]));
  const artifacts = [root, rootMisc, child, childMisc, grandchild, grandchildMisc, metadata];

  return {
    artifacts,
    expectedCids: new Set(artifacts.map(({ cid }) => cid)),
    metadata,
    root,
    source: new Map(artifacts.map(({ cid, data }) => [cid, data])),
  };
}

describe('pinning queue V1 contract', () => {
  it('upgrades legacy payloads to explicit V1 without changing the stable job ID', () => {
    const action = pinningJobContracts.jobs.find((job) => job.name === 'PIN_CID');
    assert.ok(action);

    const job = action.action({ cid: TEST_CID });
    assert.deepEqual(job, {
      name: 'PIN_CID',
      data: {
        cid: TEST_CID,
        contractVersion: PINNING_JOB_CONTRACT_VERSION,
      },
      opts: { jobId: `PIN_CID_${TEST_CID}` },
    });
  });

  it('accepts legacy queued payloads and rejects unknown future versions', () => {
    assert.deepEqual(validatePinningJobData({ cid: TEST_CID }), {
      cid: TEST_CID,
      contractVersion: PINNING_JOB_CONTRACT_VERSION,
    });
    assert.throws(
      () => validatePinningJobData({ cid: TEST_CID, contractVersion: 2 }),
      /Unsupported pinning job contract version/
    );
  });

  it('normalizes supplied metadata CIDs and gives the same set an idempotent job ID', () => {
    const action = pinningJobContracts.jobs.find((job) => job.name === 'PIN_PACKAGE');
    assert.ok(action);

    const first = action.action({
      cid: TEST_CID,
      metadataCids: [TEST_METADATA_CID, `ipfs://${TEST_METADATA_CID}`],
    });
    const replay = action.action({ cid: `ipfs://${TEST_CID}`, metadataCids: [TEST_METADATA_CID] });

    assert.deepEqual(first, replay);
    assert.deepEqual(first.data.metadataCids, [TEST_METADATA_CID]);
    assert.match(first.opts.jobId, new RegExp(`^PIN_PACKAGE_${TEST_CID}_metadata_[a-f0-9]{16}$`));
  });

  it('preserves legacy CID normalization and rejects malformed payloads without reflecting them', () => {
    assert.equal(validatePinningJobData({ cid: ` ipfs://${TEST_CID} ` }).cid, TEST_CID);
    assert.throws(() => validatePinningJobData({ cid: `${TEST_CID}/nested` }), /^Error: Invalid CID$/);
    assert.throws(() => validatePinningJobData({ cid: TEST_CID, metadataCids: ['secret payload'] }), /^Error: Invalid CID$/);
  });
});

describe('artifact closure mirroring', () => {
  it('mirrors the root, miscUrl, recursive imports, and supplied metadata with independently verified CIDs', async () => {
    const fixture = await recursiveFixture();
    const facade = mockFacade(fixture.source);

    const closure = await mirrorArtifactClosure(facade, fixture.root.cid, [fixture.metadata.cid], workerConfig());

    assert.deepEqual(new Set(closure.artifacts.keys()), fixture.expectedCids);
    assert.deepEqual(new Set(facade.reads), fixture.expectedCids);
    assert.deepEqual(new Set(facade.writes), fixture.expectedCids);
    assert.deepEqual(new Set(facade.stored.keys()), fixture.expectedCids);
    assert.equal(closure.packageCids.size, 3);
  });

  it('replays idempotently through an immutable facade', async () => {
    const fixture = await recursiveFixture();
    const facade = mockFacade(fixture.source);
    const config = workerConfig();

    await mirrorArtifactClosure(facade, fixture.root.cid, [fixture.metadata.cid], config);
    await mirrorArtifactClosure(facade, fixture.root.cid, [fixture.metadata.cid], config);

    assert.equal(facade.stored.size, fixture.expectedCids.size);
    for (const cid of fixture.expectedCids) {
      assert.deepEqual(facade.stored.get(cid), fixture.source.get(cid));
    }
  });

  it('reports both missing and extra reconciliation members', () => {
    assert.deepEqual(reconcileClosure(['a', 'b'], ['b', 'c']), {
      extra: ['c'],
      missing: ['a'],
    });
    assert.throws(() => assertExactClosure(['a'], ['b']), /1 missing, 1 extra/);
  });

  it('rejects source CID mismatches before any facade write', async () => {
    const fixture = await recursiveFixture();
    fixture.source.set(fixture.root.cid, Buffer.from('tampered'));
    const facade = mockFacade(fixture.source);

    await assert.rejects(
      mirrorArtifactClosure(facade, fixture.root.cid, [fixture.metadata.cid], workerConfig()),
      /do not match the requested CID/
    );
    assert.deepEqual(facade.writes, []);
  });

  it('rejects a compressed bomb using the bounded node:zlib inflate', async () => {
    const bomb = await compressedArtifact('x'.repeat(100_000));
    const facade = mockFacade(new Map([[bomb.cid, bomb.data]]));
    const config = workerConfig({
      ARTIFACT_MAX_CLOSURE_INFLATED_BYTES: '1024',
      ARTIFACT_MAX_INFLATED_BYTES: '1024',
    });

    await assert.rejects(discoverArtifactClosure(facade, bomb.cid, [], config), /inflated per-node limit/);
    assert.deepEqual(facade.writes, []);
  });

  it('enforces per-node, closure byte, and closure node bounds before writes', async () => {
    const fixture = await recursiveFixture();

    const nodeFacade = mockFacade(fixture.source);
    await assert.rejects(
      discoverArtifactClosure(
        nodeFacade,
        fixture.root.cid,
        [],
        workerConfig({
          ARTIFACT_MAX_COMPRESSED_BYTES: `${fixture.root.data.length - 1}`,
          ARTIFACT_MAX_NODE_BYTES: `${fixture.root.data.length - 1}`,
        })
      ),
      /per-node limit/
    );

    const closureFacade = mockFacade(fixture.source);
    await assert.rejects(
      discoverArtifactClosure(
        closureFacade,
        fixture.root.cid,
        [],
        workerConfig({
          ARTIFACT_MAX_CLOSURE_BYTES: `${fixture.root.data.length + 1}`,
          ARTIFACT_MAX_COMPRESSED_BYTES: `${fixture.root.data.length}`,
          ARTIFACT_MAX_FETCH_BYTES: `${fixture.root.data.length}`,
          ARTIFACT_MAX_NODE_BYTES: `${fixture.root.data.length}`,
        })
      ),
      /compressed byte limit/
    );

    const nodeCountFacade = mockFacade(fixture.source);
    await assert.rejects(
      discoverArtifactClosure(nodeCountFacade, fixture.root.cid, [], workerConfig({ ARTIFACT_MAX_CLOSURE_NODES: '2' })),
      /node limit/
    );
    assert.deepEqual(nodeFacade.writes, []);
    assert.deepEqual(closureFacade.writes, []);
    assert.deepEqual(nodeCountFacade.writes, []);
  });

  it('fails exact reconciliation when the writer acknowledges another CID', async () => {
    const fixture = await recursiveFixture();
    const wrongCid = (await rawArtifact('wrong acknowledgement')).cid;
    const facade = mockFacade(fixture.source, () => wrongCid);

    await assert.rejects(
      mirrorArtifactClosure(facade, fixture.root.cid, [fixture.metadata.cid], workerConfig()),
      /missing, 1 extra/
    );
  });
});

describe('graceful shutdown', () => {
  it('turns SIGTERM and SIGINT into one idempotent shutdown request', async () => {
    const source = new EventEmitter();
    const shutdown = listenForShutdown(source);

    source.emit('SIGTERM');
    source.emit('SIGINT');
    await shutdown.requested;

    assert.equal(shutdown.signal.aborted, true);
    shutdown.dispose();
    assert.equal(source.listenerCount('SIGTERM'), 0);
    assert.equal(source.listenerCount('SIGINT'), 0);
  });

  it('bounds a complete queue attempt and propagates its cancellation signal', async () => {
    let receivedSignal: AbortSignal | undefined;
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        return undefined;
      },
      async read(_cid, signal) {
        assert.ok(signal);
        receivedSignal = signal;
        markReadStarted();
        return new Promise<Buffer>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('sensitive downstream error')), { once: true });
        });
      },
      async write() {
        throw new Error('unused');
      },
    };
    const handlers = createPinningHandlers(client, workerConfig({ ARTIFACT_JOB_TIMEOUT_MS: '10' }));
    const pinCid = handlers.find(({ name }) => name === 'PIN_CID');
    assert.ok(pinCid);

    const job = pinCid.handler({ cid: TEST_CID });
    await readStarted;
    await assert.rejects(job, (error: unknown) => error instanceof Error && error.message === 'artifact job timed out');
    assert.equal(receivedSignal?.aborted, true);
  });

  it('cancels active facade work before closing the worker', async () => {
    let pinCidHandler: ReturnType<typeof createPinningHandlers>[number]['handler'] | undefined;
    let workerCloseCount = 0;
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const worker = {
      async close() {
        workerCloseCount++;
      },
      async waitUntilReady() {
        return undefined;
      },
    };
    const queue = {
      createWorker(handlers: ReturnType<typeof createPinningHandlers>) {
        pinCidHandler = handlers.find(({ name }) => name === 'PIN_CID')?.handler;
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        return undefined;
      },
      async read(_cid, signal) {
        assert.ok(signal);
        markReadStarted();
        return new Promise<Buffer>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('sensitive downstream error')), { once: true });
        });
      },
      async write() {
        throw new Error('unused');
      },
    };
    const service = await startArtifactWorker(workerEnvironment(), { client, queue, waitUntilReady: false });
    assert.ok(pinCidHandler);

    const job = pinCidHandler({ cid: TEST_CID });
    await readStarted;
    await service.close();

    await assert.rejects(job, (error: unknown) => error instanceof Error && error.message === 'artifact job cancelled');
    assert.equal(workerCloseCount, 1);
  });

  it('closes every resource, retries only failures, and keeps errors generic', async () => {
    let workerCloseCount = 0;
    let queueCloseCount = 0;
    const worker = {
      async close() {
        workerCloseCount++;
        if (workerCloseCount === 1) throw new Error('writer-secret redis://secret');
      },
    };
    const queue = {
      async close() {
        queueCloseCount++;
      },
    };
    const close = createRetryableResourceCloser(() => [worker, queue], 'queue cleanup failed');

    await assert.rejects(
      close(),
      (error: unknown) =>
        error instanceof Error && error.message === 'queue cleanup failed' && !error.message.includes('secret')
    );
    assert.equal(workerCloseCount, 1);
    assert.equal(queueCloseCount, 1);

    await Promise.all([close(), close()]);
    await close();
    assert.equal(workerCloseCount, 2);
    assert.equal(queueCloseCount, 1);
  });
});

describe('worker readiness', () => {
  it('preserves autorun when callers explicitly bypass startup readiness', async () => {
    let autorun: boolean | undefined;
    const worker = {
      async close() {
        return undefined;
      },
      async waitUntilReady() {
        throw new Error('readiness should be bypassed');
      },
    };
    const queue = {
      createWorker(_handlers: unknown, options?: { autorun?: boolean }) {
        autorun = options?.autorun;
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        throw new Error('health should be bypassed');
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };

    const service = await startArtifactWorker(workerEnvironment(), { client, queue, waitUntilReady: false });
    assert.equal(autorun, true);
    await service.close();
  });

  it('requires both Redis worker readiness and facade health', async () => {
    const calls: string[] = [];
    const worker = {
      async close() {
        calls.push('worker-close');
      },
      async run() {
        calls.push('worker-run');
      },
      async waitUntilReady() {
        calls.push('redis-ready');
      },
    };
    const queue = {
      createWorker() {
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        calls.push('facades-ready');
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };

    const service = await startArtifactWorker(workerEnvironment(), { client, queue });
    assert.deepEqual(calls, ['redis-ready', 'facades-ready', 'worker-run']);
    await service.close();
    assert.deepEqual(calls, ['redis-ready', 'facades-ready', 'worker-run', 'worker-close']);
  });

  it('closes the worker and redacts dependency details when readiness fails', async () => {
    let closeCount = 0;
    const worker = {
      async close() {
        closeCount++;
      },
      async waitUntilReady() {
        throw new Error('redis://worker:secret@redis.internal:6379');
      },
    };
    const queue = {
      createWorker() {
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        throw new Error('writer health unavailable');
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };

    await assert.rejects(
      startArtifactWorker(workerEnvironment(), { client, queue }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'artifact worker readiness failed' &&
        !error.message.includes('secret') &&
        !error.message.includes('redis.internal') &&
        !error.message.includes('writer health')
    );
    assert.equal(closeCount, 1);
  });

  it('does not start consuming jobs after shutdown is requested during readiness', async () => {
    let runCount = 0;
    let forcedClose = false;
    const worker = {
      async close(force?: boolean) {
        forcedClose = force === true;
      },
      async run() {
        runCount++;
      },
      async waitUntilReady() {
        return undefined;
      },
    };
    const queue = {
      createWorker() {
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        return undefined;
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };
    const shutdown = new AbortController();
    shutdown.abort();

    await assert.rejects(
      startArtifactWorker(workerEnvironment(), { client, queue, shutdownSignal: shutdown.signal }),
      /artifact worker readiness failed/
    );
    assert.equal(runCount, 0);
    assert.equal(forcedClose, true);
  });

  it('reports an unexpected worker-loop stop to the supervisor without exposing its error', async () => {
    let rejectRun: (error: Error) => void = () => undefined;
    const run = new Promise<void>((_resolve, reject) => {
      rejectRun = reject;
    });
    const worker = {
      async close() {
        return undefined;
      },
      run() {
        return run;
      },
      async waitUntilReady() {
        return undefined;
      },
    };
    const queue = {
      createWorker() {
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        return undefined;
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };
    const shutdown = new AbortController();
    const service = await startArtifactWorker(workerEnvironment(), { client, queue });
    const supervised = waitForArtifactWorkerShutdown(
      { requested: new Promise<void>(() => undefined), signal: shutdown.signal },
      service.stopped
    );

    rejectRun(new Error('redis://worker:secret@redis.internal:6379'));
    await assert.rejects(
      supervised,
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'artifact worker stopped unexpectedly' &&
        !error.message.includes('secret') &&
        !error.message.includes('redis.internal')
    );
    await service.close();
  });

  it('allows a failed service cleanup to be retried and then becomes idempotent', async () => {
    let closeCount = 0;
    const worker = {
      async close() {
        closeCount++;
        if (closeCount === 1) throw new Error('redis://secret');
      },
      async waitUntilReady() {
        return undefined;
      },
    };
    const queue = {
      createWorker() {
        return worker;
      },
    } as unknown as Queue;
    const client: ArtifactFacadeClient = {
      async checkHealth() {
        return undefined;
      },
      async read() {
        throw new Error('unused');
      },
      async write() {
        throw new Error('unused');
      },
    };
    const service = await startArtifactWorker(workerEnvironment(), { client, queue, waitUntilReady: false });

    await assert.rejects(
      service.close(),
      (error: unknown) =>
        error instanceof Error && error.message === 'artifact worker cleanup failed' && !error.message.includes('secret')
    );
    await service.close();
    await service.close();
    assert.equal(closeCount, 2);
  });
});
