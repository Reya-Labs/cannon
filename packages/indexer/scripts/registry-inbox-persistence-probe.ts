import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createRegistryCheckpoint } from '../src/registry-checkpoint';
import { decodeRegistryEventEnvelope } from '../src/registry-event-envelope';
import { commitRegistryScanBatch, loadRegistryInboxState, registryInboxKeys } from '../src/registry-inbox';
import { createRegistryScanBatch } from '../src/registry-scan-batch';

const CHAIN_ID = 72_200_001;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'cd'.repeat(32)}`;
const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const OWNER = `0x${'22'.repeat(20)}`;

async function main(): Promise<void> {
  const phase = process.argv[2];
  const redisUrl = process.env.REGISTRY_INBOX_TEST_REDIS_URL;
  if (!redisUrl || !['wait', 'seed', 'verify'].includes(phase)) {
    throw new Error('persistence probe requires a Redis URL and wait, seed or verify phase');
  }

  const redis = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 1_000,
      reconnectStrategy: false,
    },
  });
  redis.on('error', () => undefined);
  await redis.connect();
  const keys = registryInboxKeys(CHAIN_ID);

  try {
    if (phase === 'wait') return;

    if (phase === 'seed') {
      await redis.del([keys.stream, keys.state]);
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
      await commitRegistryScanBatch(
        redis,
        createRegistryScanBatch({
          registryChainId: CHAIN_ID,
          previousCheckpoint: null,
          scanFromBlock: 100n,
          checkpoint,
          scanToTimestamp: 1_700_000_100n,
          events: [event],
        })
      );
      return;
    }

    const state = await loadRegistryInboxState(redis, CHAIN_ID);
    assert.equal(state?.checkpoint.blockNumber, '100');
    assert.equal(state?.streamLength, 1);
    assert.equal(await redis.xLen(keys.stream), 1);
    await redis.del([keys.stream, keys.state]);
  } finally {
    await redis.quit();
  }
}

void main().catch(() => {
  // Keep connection details and persisted payloads out of executable diagnostics.
  // eslint-disable-next-line no-console
  console.error('registry inbox persistence probe failed');
  process.exitCode = 1;
});
