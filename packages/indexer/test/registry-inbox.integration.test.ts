/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createClient } from 'redis';
import { createRegistryCheckpoint } from '../src/registry-checkpoint';
import { decodeRegistryEventEnvelope, serializeRegistryEventEnvelope } from '../src/registry-event-envelope';
import { commitRegistryScanBatch, loadRegistryInboxState, registryInboxKeys } from '../src/registry-inbox';
import { createRegistryScanBatch, registryEventStreamId } from '../src/registry-scan-batch';

const TEST_REDIS_URL = process.env.REGISTRY_INBOX_TEST_REDIS_URL;
const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const OWNER = `0x${'22'.repeat(20)}`;

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

function event(registryChainId: number, blockNumber: bigint, logIndex: number, owner = OWNER) {
  return decodeRegistryEventEnvelope(registryChainId, {
    eventName: 'PackageOwnerChanged',
    args: { name: PACKAGE_NAME, owner },
    blockNumber,
    blockHash: bytes32(Number(blockNumber % 1_000_000n) + 1),
    transactionHash: bytes32(logIndex + 1000),
    logIndex,
    timestamp: 1_700_000_000n + blockNumber,
  });
}

function coldBatch(registryChainId: number, events = [event(registryChainId, 100n, 1)]) {
  return createRegistryScanBatch({
    registryChainId,
    previousCheckpoint: null,
    scanFromBlock: 100n,
    checkpoint: checkpoint(registryChainId, 101n),
    scanToTimestamp: 1_700_000_101n,
    events,
  });
}

describe('registry durable inbox against real Redis', { skip: !TEST_REDIS_URL }, () => {
  let redis: ReturnType<typeof createClient>;
  let nextChainId = 7_220_000 + (process.pid % 10_000) * 100;
  const allocatedChainIds: number[] = [];

  function allocateChainId(): number {
    const chainId = nextChainId++;
    allocatedChainIds.push(chainId);
    return chainId;
  }

  before(async () => {
    redis = createClient({ url: TEST_REDIS_URL });
    redis.on('error', () => undefined);
    await redis.connect();
  });

  after(async () => {
    for (const chainId of allocatedChainIds) {
      const keys = registryInboxKeys(chainId);
      await redis.del([keys.stream, keys.state]);
    }
    await redis.quit();
  });

  it('commits stream entries before checkpoint state and replays byte-identically without duplication', async () => {
    const chainId = allocateChainId();
    const events = [event(chainId, 100n, 1), event(chainId, 101n, 2)];
    const batch = coldBatch(chainId, events);

    const first = await commitRegistryScanBatch(redis, batch);
    const replay = await commitRegistryScanBatch(redis, batch);
    const keys = registryInboxKeys(chainId);
    const entries = await redis.xRange(keys.stream, '-', '+');

    assert.equal(first.status, 'committed');
    assert.equal(first.insertedEventCount, 2);
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.insertedEventCount, 0);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map(({ id }) => id),
      ['100-1', '101-2']
    );
    assert.deepEqual(await loadRegistryInboxState(redis, chainId), first.state);
  });

  it('commits the exact boundary successor and preserves cumulative stream order', async () => {
    const chainId = allocateChainId();
    const firstBatch = coldBatch(chainId, [event(chainId, 100n, 1), event(chainId, 101n, 2)]);
    const first = await commitRegistryScanBatch(redis, firstBatch);
    const successorBatch = createRegistryScanBatch({
      registryChainId: chainId,
      previousCheckpoint: firstBatch.checkpoint,
      scanFromBlock: 102n,
      checkpoint: checkpoint(chainId, 103n),
      scanToTimestamp: 1_700_000_103n,
      events: [event(chainId, 102n, 1), event(chainId, 103n, 2)],
    });

    const successor = await commitRegistryScanBatch(redis, successorBatch);
    const replay = await commitRegistryScanBatch(redis, successorBatch);
    const keys = registryInboxKeys(chainId);
    const entries = await redis.xRange(keys.stream, '-', '+');

    assert.equal(first.state.streamLength, 2);
    assert.equal(successor.status, 'committed');
    assert.equal(successor.state.streamLength, 4);
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(
      entries.map(({ id }) => id),
      ['100-1', '101-2', '102-1', '103-2']
    );
    assert.deepEqual(await loadRegistryInboxState(redis, chainId), successor.state);
  });

  it('serializes identical concurrent commits as one commit and one verified replay', async () => {
    const chainId = allocateChainId();
    const input = coldBatch(chainId);

    const results = await Promise.all([commitRegistryScanBatch(redis, input), commitRegistryScanBatch(redis, input)]);
    const keys = registryInboxKeys(chainId);

    assert.deepEqual(results.map(({ status }) => status).sort(), ['committed', 'replayed']);
    assert.equal(
      results.reduce((sum, result) => sum + result.insertedEventCount, 0),
      1
    );
    assert.equal(await redis.xLen(keys.stream), 1);
    assert.deepEqual(await loadRegistryInboxState(redis, chainId), results[0].state);
  });

  it('allows exactly one concurrent batch with the same predecessor to win', async () => {
    const chainId = allocateChainId();
    const firstCandidate = coldBatch(chainId, [event(chainId, 100n, 1, OWNER)]);
    const secondCandidate = coldBatch(chainId, [event(chainId, 100n, 1, `0x${'33'.repeat(20)}`)]);

    const outcomes = await Promise.allSettled([
      commitRegistryScanBatch(redis, firstCandidate),
      commitRegistryScanBatch(redis, secondCandidate),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
    const winner = winners[0];
    const loser = losers[0];
    const keys = registryInboxKeys(chainId);

    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(winner?.status, 'fulfilled');
    assert.equal(loser?.status, 'rejected');
    if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') {
      throw new Error('concurrent registry inbox test did not produce one winner and one loser');
    }
    assert.equal(winner.value.status, 'committed');
    assert.match(String(loser.reason), /predecessor conflict/i);
    assert.equal(await redis.xLen(keys.stream), 1);
    assert.deepEqual(await loadRegistryInboxState(redis, chainId), winner.value.state);
  });

  it('recovers an identical event prefix left before the checkpoint write', async () => {
    const chainId = allocateChainId();
    const events = [event(chainId, 100n, 1), event(chainId, 101n, 2)];
    const batch = coldBatch(chainId, events);
    const keys = registryInboxKeys(chainId);

    await redis.xAdd(keys.stream, registryEventStreamId(events[0]), {
      event: serializeRegistryEventEnvelope(events[0]),
    });

    const result = await commitRegistryScanBatch(redis, batch);

    assert.equal(result.status, 'committed');
    assert.equal(result.insertedEventCount, 1);
    assert.equal(await redis.xLen(keys.stream), 2);
    assert.equal((await loadRegistryInboxState(redis, chainId))?.streamLength, 2);
  });

  it('rejects a conflicting same-position payload and leaves the checkpoint absent', async () => {
    const chainId = allocateChainId();
    const expected = event(chainId, 100n, 1);
    const conflicting = event(chainId, 100n, 1, `0x${'33'.repeat(20)}`);
    const batch = coldBatch(chainId, [expected]);
    const keys = registryInboxKeys(chainId);

    await redis.xAdd(keys.stream, registryEventStreamId(conflicting), {
      event: serializeRegistryEventEnvelope(conflicting),
    });

    await assert.rejects(() => commitRegistryScanBatch(redis, batch), /registry inbox event conflict/i);
    assert.equal(await redis.get(keys.state), null);
    assert.equal(await redis.xLen(keys.stream), 1);
  });

  it('rejects replay after a committed event is truncated instead of masking corruption', async () => {
    const chainId = allocateChainId();
    const events = [event(chainId, 100n, 1), event(chainId, 101n, 2)];
    const batch = coldBatch(chainId, events);
    const keys = registryInboxKeys(chainId);
    await commitRegistryScanBatch(redis, batch);
    const stateBefore = await redis.get(keys.state);

    await redis.xDel(keys.stream, registryEventStreamId(events[1]));

    await assert.rejects(() => commitRegistryScanBatch(redis, batch), /replay integrity conflict/i);
    assert.equal(await redis.get(keys.state), stateBefore);
    assert.equal(await redis.xLen(keys.stream), 1);
  });

  it('rejects a stale predecessor without changing stream or checkpoint state', async () => {
    const chainId = allocateChainId();
    const first = coldBatch(chainId);
    await commitRegistryScanBatch(redis, first);
    const keys = registryInboxKeys(chainId);
    const stateBefore = await redis.get(keys.state);
    const lengthBefore = await redis.xLen(keys.stream);
    const stale = createRegistryScanBatch({
      registryChainId: chainId,
      previousCheckpoint: null,
      scanFromBlock: 102n,
      checkpoint: checkpoint(chainId, 102n),
      scanToTimestamp: 1_700_000_102n,
      events: [event(chainId, 102n, 1)],
    });

    await assert.rejects(() => commitRegistryScanBatch(redis, stale), /predecessor conflict/i);
    assert.equal(await redis.get(keys.state), stateBefore);
    assert.equal(await redis.xLen(keys.stream), lengthBefore);
  });

  it('advances an empty scan checkpoint without creating a stream entry', async () => {
    const chainId = allocateChainId();
    const batch = coldBatch(chainId, []);
    const result = await commitRegistryScanBatch(redis, batch);
    const keys = registryInboxKeys(chainId);

    assert.equal(result.status, 'committed');
    assert.equal(result.insertedEventCount, 0);
    assert.equal(result.state.streamLength, 0);
    assert.equal(await redis.xLen(keys.stream), 0);
    assert.deepEqual(await loadRegistryInboxState(redis, chainId), result.state);
  });

  it('survives a lost response and reconnect with one durable copy', async () => {
    const chainId = allocateChainId();
    const batch = coldBatch(chainId);
    const firstConnection = createClient({ url: TEST_REDIS_URL });
    firstConnection.on('error', () => undefined);
    await firstConnection.connect();
    await commitRegistryScanBatch(firstConnection, batch);
    await firstConnection.quit();

    const secondConnection = createClient({ url: TEST_REDIS_URL });
    secondConnection.on('error', () => undefined);
    await secondConnection.connect();
    const replay = await commitRegistryScanBatch(secondConnection, batch);
    const keys = registryInboxKeys(chainId);

    assert.equal(replay.status, 'replayed');
    assert.equal(await secondConnection.xLen(keys.stream), 1);
    await secondConnection.quit();
  });
});
