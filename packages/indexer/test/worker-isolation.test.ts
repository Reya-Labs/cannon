/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runIndexerProcess } from '../src/process-mode';
import { PINNING_JOB_CONTRACT_VERSION, pinningJobContracts, validatePinningJobData } from '../src/queue/contracts';
import { loadArtifactWorkerConfig } from '../src/worker-config';
import type { Queue } from '../src/queue';

const TEST_CID = 'QmWPYWDSbBvDu1D2S2mb3vfBT59Z3dMvwaWHKmLfpU6ABC';

describe('artifact worker isolation', () => {
  it('starts the registry process without importing or starting a failing artifact worker', async () => {
    const calls: string[] = [];

    await runIndexerProcess('registry', {
      runRegistry: async () => {
        calls.push('registry');
      },
      startArtifactWorker: async () => {
        throw new Error("Cannot find module '@usecannon/repo'");
      },
    });

    assert.deepEqual(calls, ['registry']);
  });

  it('keeps combined mode fail-closed if the worker cannot start', async () => {
    let registryStarted = false;
    const registryQueue = {} as Queue;
    let workerQueue: Queue | undefined;

    await assert.rejects(
      runIndexerProcess('combined', {
        runRegistry: async (startArtifactWorker) => {
          await startArtifactWorker?.(registryQueue);
          registryStarted = true;
        },
        startArtifactWorker: async (waitUntilReady, queue) => {
          assert.equal(waitUntilReady, false);
          workerQueue = queue;
          throw new Error('privileged worker failed');
        },
      }),
      /privileged worker failed/
    );

    assert.equal(registryStarted, false);
    assert.equal(workerQueue, registryQueue);
  });

  it('validates combined-mode worker credentials before registry startup', async () => {
    let registryStarted = false;
    let workerStarted = false;

    await assert.rejects(
      runIndexerProcess('combined', {
        runRegistry: async () => {
          registryStarted = true;
        },
        startArtifactWorker: async () => {
          workerStarted = true;
        },
        validateArtifactWorker: () => {
          throw new Error('S3 credentials missing');
        },
      }),
      /S3 credentials missing/
    );

    assert.equal(registryStarted, false);
    assert.equal(workerStarted, false);
  });

  it('runs the artifact worker entrypoint without loading the registry', async () => {
    const calls: string[] = [];

    await runIndexerProcess('artifact-worker', {
      runRegistry: async () => {
        throw new Error('registry must not load in artifact-worker mode');
      },
      startArtifactWorker: async () => {
        calls.push('artifact-worker');
      },
    });

    assert.deepEqual(calls, ['artifact-worker']);
  });

  it('fails artifact-worker mode closed when privileged credentials are absent', async () => {
    await assert.rejects(
      runIndexerProcess('artifact-worker', {
        runRegistry: async () => {
          throw new Error('registry must not load in artifact-worker mode');
        },
        startArtifactWorker: async (waitUntilReady) => {
          assert.equal(waitUntilReady, true);
          loadArtifactWorkerConfig({
            IPFS_URL: 'https://artifacts.example.com',
            NODE_ENV: 'production',
            REDIS_URL: 'rediss://redis.example.com:6379',
          });
        },
      }),
      /S3_ENDPOINT must be configured explicitly/
    );
  });
});

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

  it('preserves legacy ipfs URL normalization and rejects malformed payloads', () => {
    assert.equal(validatePinningJobData({ cid: ` ipfs://${TEST_CID} ` }).cid, TEST_CID);
    assert.throws(() => validatePinningJobData({ cid: `${TEST_CID}/nested` }), /Invalid CID/);
  });
});
