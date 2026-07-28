/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRegistryCheckpoint } from '../src/registry-checkpoint';
import { decodeRegistryEventEnvelope, RegistryEventEnvelopeV1 } from '../src/registry-event-envelope';
import {
  createRegistryScanBatch,
  parseRegistryScanBatch,
  registryEventStreamId,
  registryScanBatchDigest,
  REGISTRY_SCAN_BATCH_MAX_EVENTS,
  REGISTRY_SCAN_BATCH_MAX_PUBLISHERS,
  REGISTRY_SCAN_BATCH_MAX_SERIALIZED_BYTES,
  REGISTRY_SCAN_BATCH_MAX_URL_BYTES,
  serializeRegistryScanBatch,
} from '../src/registry-scan-batch';

const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const OWNER = `0x${'22'.repeat(20)}`;
const TAG = `0x${'33'.repeat(32)}`;
const VARIANT = `0x${'44'.repeat(32)}`;

function bytes32(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function checkpoint(registryChainId: number, blockNumber: bigint) {
  return createRegistryCheckpoint({
    registryChainId,
    blockNumber,
    blockHash: bytes32(Number(blockNumber % 1_000_000n) + 1),
  });
}

function ownerEvent(
  registryChainId: number,
  blockNumber: bigint,
  logIndex: number,
  timestamp = blockNumber + 1_700_000_000n
): RegistryEventEnvelopeV1 {
  return decodeRegistryEventEnvelope(registryChainId, {
    eventName: 'PackageOwnerChanged',
    args: { name: PACKAGE_NAME, owner: OWNER },
    blockNumber,
    blockHash: bytes32(Number(blockNumber % 1_000_000n) + 1),
    transactionHash: bytes32(logIndex + 1000),
    logIndex,
    timestamp,
  });
}

function publishEvent(
  input: {
    registryChainId?: number;
    blockNumber?: bigint;
    logIndex?: number;
    timestamp?: bigint;
    deployUrl?: string;
    metaUrl?: string;
  } = {}
): RegistryEventEnvelopeV1 {
  const registryChainId = input.registryChainId ?? 1;
  const blockNumber = input.blockNumber ?? 100n;
  const logIndex = input.logIndex ?? 1;
  return decodeRegistryEventEnvelope(registryChainId, {
    eventName: 'PackagePublishWithFee',
    args: {
      name: PACKAGE_NAME,
      tag: TAG,
      variant: VARIANT,
      deployUrl: input.deployUrl ?? 'ipfs://bafy-deploy',
      metaUrl: input.metaUrl ?? 'ipfs://bafy-meta',
      owner: OWNER,
      feePaid: 42n,
    },
    blockNumber,
    blockHash: bytes32(Number(blockNumber % 1_000_000n) + 1),
    transactionHash: bytes32(logIndex + 2000),
    logIndex,
    timestamp: input.timestamp ?? blockNumber + 1_700_000_000n,
  });
}

describe('registry scan batch', () => {
  it('roundtrips a canonical bounded batch with a deterministic digest', () => {
    const batch = createRegistryScanBatch({
      registryChainId: 1,
      previousCheckpoint: null,
      scanFromBlock: 100n,
      checkpoint: checkpoint(1, 101n),
      scanToTimestamp: 1_700_000_101n,
      events: [ownerEvent(1, 100n, 1), ownerEvent(1, 101n, 2)],
    });

    const serialized = serializeRegistryScanBatch(batch);
    const restored = parseRegistryScanBatch(serialized);

    assert.deepEqual(restored, batch);
    assert.equal(serializeRegistryScanBatch(restored), serialized);
    assert.equal(registryScanBatchDigest(restored), registryScanBatchDigest(batch));
    assert.match(registryScanBatchDigest(batch), /^sha256:[0-9a-f]{64}$/);
  });

  it('requires the exact checkpoint successor and keeps events within the scanned range', () => {
    const previousCheckpoint = checkpoint(1, 100n);

    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 101n),
          scanToTimestamp: 1_700_000_101n,
          events: [],
        }),
      /checkpoint successor/
    );

    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint,
          scanFromBlock: 101n,
          checkpoint: checkpoint(1, 102n),
          scanToTimestamp: 1_700_000_102n,
          events: [ownerEvent(1, 100n, 1)],
        }),
      /outside the scan block range/
    );
  });

  it('rejects cross-chain, future-timestamp, duplicate and out-of-order events', () => {
    const common = {
      registryChainId: 1,
      previousCheckpoint: null,
      scanFromBlock: 100n,
      checkpoint: checkpoint(1, 101n),
      scanToTimestamp: 1_700_000_101n,
    };

    assert.throws(
      () => createRegistryScanBatch({ ...common, events: [ownerEvent(10, 100n, 1)] }),
      /registry chain mismatch/
    );
    assert.throws(
      () => createRegistryScanBatch({ ...common, events: [ownerEvent(1, 100n, 1, 1_700_000_102n)] }),
      /timestamp exceeds/
    );
    const event = ownerEvent(1, 100n, 1);
    assert.throws(() => createRegistryScanBatch({ ...common, events: [event, event] }), /strictly ordered/);
    assert.throws(
      () =>
        createRegistryScanBatch({
          ...common,
          events: [ownerEvent(1, 101n, 2), ownerEvent(1, 100n, 3)],
        }),
      /strictly ordered/
    );
  });

  it('rejects internally inconsistent and checkpoint-divergent block hashes', () => {
    const first = ownerEvent(1, 100n, 1);
    const conflicting = decodeRegistryEventEnvelope(1, {
      eventName: 'PackageOwnerChanged',
      args: { name: PACKAGE_NAME, owner: OWNER },
      blockNumber: 100n,
      blockHash: bytes32(999),
      transactionHash: bytes32(1002),
      logIndex: 2,
      timestamp: 1_700_000_100n,
    });

    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 101n),
          scanToTimestamp: 1_700_000_101n,
          events: [first, conflicting],
        }),
      /share its block hash/
    );
    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: {
            ...checkpoint(1, 100n),
            blockHash: bytes32(999),
          },
          scanToTimestamp: 1_700_000_100n,
          events: [first],
        }),
      /must match the checkpoint/
    );
  });

  it('enforces event-count, URL, publisher-count and aggregate byte bounds', () => {
    const tooManyEvents = Array.from({ length: REGISTRY_SCAN_BATCH_MAX_EVENTS + 1 }, (_, index) =>
      ownerEvent(1, 100n, index + 1)
    );
    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 100n),
          scanToTimestamp: 1_700_000_100n,
          events: tooManyEvents,
        }),
      /item limit/
    );

    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 100n),
          scanToTimestamp: 1_700_000_100n,
          events: [publishEvent({ deployUrl: 'd'.repeat(REGISTRY_SCAN_BATCH_MAX_URL_BYTES + 1) })],
        }),
      /deployUrl exceeds/
    );

    const publishers = Array.from(
      { length: REGISTRY_SCAN_BATCH_MAX_PUBLISHERS + 1 },
      (_, index) => `0x${index.toString(16).padStart(40, '0')}`
    );
    const publishersEvent = decodeRegistryEventEnvelope(1, {
      eventName: 'PackagePublishersChanged',
      args: { name: PACKAGE_NAME, publisher: publishers },
      blockNumber: 100n,
      blockHash: bytes32(101),
      transactionHash: bytes32(51),
      logIndex: 1,
      timestamp: 1_700_000_100n,
    });
    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 100n),
          scanToTimestamp: 1_700_000_100n,
          events: [publishersEvent],
        }),
      /publisher-count/
    );

    const largeEvents = Array.from({ length: 300 }, (_, index) =>
      publishEvent({
        logIndex: index + 1,
        deployUrl: 'd'.repeat(REGISTRY_SCAN_BATCH_MAX_URL_BYTES),
        metaUrl: 'm'.repeat(REGISTRY_SCAN_BATCH_MAX_URL_BYTES),
      })
    );
    assert.throws(
      () =>
        createRegistryScanBatch({
          registryChainId: 1,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint: checkpoint(1, 100n),
          scanToTimestamp: 1_700_000_100n,
          events: largeEvents,
        }),
      /serialized batch exceeds/
    );
  });

  it('maps canonical log positions to deterministic Redis stream IDs and rejects 0-0', () => {
    assert.equal(registryEventStreamId(ownerEvent(1, 100n, 7)), '100-7');
    assert.throws(() => registryEventStreamId(ownerEvent(1, 0n, 0, 0n)), /reserved Redis stream ID/);
  });

  it('fails closed for non-canonical and extended serialized batches', () => {
    const batch = createRegistryScanBatch({
      registryChainId: 1,
      previousCheckpoint: null,
      scanFromBlock: 100n,
      checkpoint: checkpoint(1, 100n),
      scanToTimestamp: 1_700_000_100n,
      events: [],
    });
    const serialized = serializeRegistryScanBatch(batch);
    const value = JSON.parse(serialized);

    assert.throws(() => parseRegistryScanBatch('x'.repeat(REGISTRY_SCAN_BATCH_MAX_SERIALIZED_BYTES + 1)), /batch limit/);
    assert.throws(() => parseRegistryScanBatch(` ${serialized}`), /not canonical/);
    assert.throws(() => parseRegistryScanBatch(JSON.stringify({ ...value, version: 0 })), /unsupported version/);
    assert.throws(() => parseRegistryScanBatch(JSON.stringify({ ...value, futureField: true })), /unexpected fields/);
    assert.throws(() => parseRegistryScanBatch('{'), /not valid JSON/);
  });

  it('preserves canonical roundtrip and digest invariants across randomized valid batches', () => {
    let state = 0x722c0de;
    const random = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };

    for (let iteration = 0; iteration < 2_000; iteration++) {
      const chainId = random() % 2 === 0 ? 1 : 10;
      const block = BigInt(1 + (random() % 1_000_000));
      const logIndex = 1 + (random() % 10_000);
      const timestamp = 1_700_000_000n + block;
      const batch = createRegistryScanBatch({
        registryChainId: chainId,
        previousCheckpoint: null,
        scanFromBlock: block,
        checkpoint: checkpoint(chainId, block),
        scanToTimestamp: timestamp,
        events: [ownerEvent(chainId, block, logIndex, timestamp)],
      });
      const serialized = serializeRegistryScanBatch(batch);

      assert.deepEqual(parseRegistryScanBatch(serialized), batch);
      assert.equal(registryScanBatchDigest(parseRegistryScanBatch(serialized)), registryScanBatchDigest(batch));
    }
  });
});
