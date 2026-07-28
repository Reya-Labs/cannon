/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRegistryCheckpoint } from '../src/registry-checkpoint';
import { decodeRegistryEventEnvelope } from '../src/registry-event-envelope';
import {
  commitRegistryScanBatch,
  parseRegistryInboxState,
  REGISTRY_INBOX_STATE_MAX_SERIALIZED_BYTES,
  registryInboxKeys,
  RegistryInboxRedis,
} from '../src/registry-inbox';
import { createRegistryScanBatch, REGISTRY_SCAN_BATCH_MAX_EVENTS } from '../src/registry-scan-batch';

const CHAIN_ID = 1;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'cd'.repeat(32)}`;
const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const OWNER = `0x${'22'.repeat(20)}`;

function batch() {
  const event = decodeRegistryEventEnvelope(CHAIN_ID, {
    eventName: 'PackageOwnerChanged',
    args: { name: PACKAGE_NAME, owner: OWNER },
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
    logIndex: 1,
    timestamp: 1_700_000_100n,
  });
  const checkpoint = createRegistryCheckpoint({
    registryChainId: CHAIN_ID,
    blockNumber: 100n,
    blockHash: BLOCK_HASH,
  });
  return createRegistryScanBatch({
    registryChainId: CHAIN_ID,
    previousCheckpoint: null,
    scanFromBlock: 100n,
    checkpoint,
    scanToTimestamp: 1_700_000_100n,
    events: [event],
  });
}

describe('registry inbox client contract', () => {
  it('uses a fresh same-slot V2 namespace without legacy registry keys', () => {
    const keys = registryInboxKeys(10);

    assert.equal(keys.stream, 'cannon:registry:v2:{cannon-registry-v2:10}:inbox');
    assert.equal(keys.state, 'cannon:registry:v2:{cannon-registry-v2:10}:state');
    assert.equal(keys.stream.match(/\{[^}]+\}/)?.[0], keys.state.match(/\{[^}]+\}/)?.[0]);
    assert.doesNotMatch(`${keys.stream} ${keys.state}`, /reg:lastBlock|reg:laterEvent|reg:retryPackage/);
  });

  it('calls the bounded commit script and parses its canonical desired state', async () => {
    let evaluated:
      | {
          keys: string[];
          arguments: string[];
        }
      | undefined;
    const redis: RegistryInboxRedis = {
      async get() {
        return null;
      },
      async eval(_script, options) {
        evaluated = options;
        return [1, 1];
      },
    };

    const result = await commitRegistryScanBatch(redis, batch());

    assert.equal(result.status, 'committed');
    assert.equal(result.insertedEventCount, 1);
    assert.deepEqual(evaluated?.keys, Object.values(registryInboxKeys(CHAIN_ID)));
    assert.equal(evaluated?.arguments[3], '1');
    assert.deepEqual(parseRegistryInboxState(evaluated!.arguments[1]), result.state);
  });

  it('routes an exact replay through the integrity script instead of trusting state alone', async () => {
    let persistedState: string | null = null;
    let evaluations = 0;
    const redis: RegistryInboxRedis = {
      async get() {
        return persistedState;
      },
      async eval(_script, options) {
        evaluations++;
        if (persistedState === null) {
          persistedState = options.arguments[1];
          return [1, 1];
        }
        assert.equal(options.arguments[1], persistedState);
        return [0, 0];
      },
    };
    const input = batch();

    await commitRegistryScanBatch(redis, input);
    const replay = await commitRegistryScanBatch(redis, input);

    assert.equal(replay.status, 'replayed');
    assert.equal(evaluations, 2);
  });

  it('rejects malformed, extended and non-canonical state', () => {
    const valid = JSON.stringify({
      version: 1,
      registryChainId: 1,
      checkpoint: {
        version: 1,
        registryChainId: 1,
        blockNumber: '100',
        blockHash: BLOCK_HASH,
      },
      scanFromBlock: '100',
      scanToTimestamp: '1700000100',
      batchDigest: `sha256:${'12'.repeat(32)}`,
      batchEventCount: 1,
      streamLength: 1,
    });
    const value = JSON.parse(valid);

    assert.equal(parseRegistryInboxState(valid).streamLength, 1);
    assert.throws(() => parseRegistryInboxState(` ${valid}`), /not canonical/);
    assert.throws(() => parseRegistryInboxState(JSON.stringify({ ...value, version: 0 })), /unsupported/);
    assert.throws(() => parseRegistryInboxState(JSON.stringify({ ...value, futureField: true })), /unexpected fields/);
    assert.throws(() => parseRegistryInboxState(JSON.stringify({ ...value, streamLength: 0 })), /exceeds streamLength/);
  });

  it('fails closed on restored state outside batch and Redis bounds', () => {
    const valid = {
      version: 1,
      registryChainId: 1,
      checkpoint: {
        version: 1,
        registryChainId: 1,
        blockNumber: '100',
        blockHash: BLOCK_HASH,
      },
      scanFromBlock: '100',
      scanToTimestamp: '1700000100',
      batchDigest: `sha256:${'12'.repeat(32)}`,
      batchEventCount: 1,
      streamLength: 1,
    };
    const parse = (override: Record<string, unknown>) => parseRegistryInboxState(JSON.stringify({ ...valid, ...override }));

    assert.throws(() => parseRegistryInboxState('x'.repeat(REGISTRY_INBOX_STATE_MAX_SERIALIZED_BYTES + 1)), /state limit/);
    assert.throws(() => parse({ scanToTimestamp: (1n << 256n).toString() }), /fit uint256/);
    assert.throws(() => parse({ scanFromBlock: '101' }), /checkpoint precedes/);
    assert.throws(
      () =>
        parse({
          checkpoint: {
            ...valid.checkpoint,
            blockNumber: (1n << 64n).toString(),
          },
        }),
      /Redis stream ID limit/
    );
    assert.throws(
      () =>
        parse({
          batchEventCount: REGISTRY_SCAN_BATCH_MAX_EVENTS + 1,
          streamLength: REGISTRY_SCAN_BATCH_MAX_EVENTS + 1,
        }),
      /item limit/
    );
  });

  it('fails closed on an invalid Redis script response', async () => {
    for (const response of ['unexpected', ['1', 1], [0, 1], [1, 2]]) {
      const redis: RegistryInboxRedis = {
        async get() {
          return null;
        },
        async eval() {
          return response;
        },
      };

      await assert.rejects(() => commitRegistryScanBatch(redis, batch()), /invalid response/);
    }
  });
});
