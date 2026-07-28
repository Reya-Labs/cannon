import { createClient } from 'redis';
import { createRegistryCheckpoint } from '../src/registry-checkpoint';
import { decodeRegistryEventEnvelope, parseRegistryEventEnvelope } from '../src/registry-event-envelope';
import { commitRegistryScanBatch, parseRegistryInboxState, registryInboxKeys } from '../src/registry-inbox';
import { createRegistryScanBatch } from '../src/registry-scan-batch';

const CHAIN_ID = 72_200_001;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'cd'.repeat(32)}`;
const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const OWNER = `0x${'22'.repeat(20)}`;

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`persistence verification failed: missing ${name}`);
  return value;
}

function verify(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`persistence verification failed: ${reason}`);
}

function verifyReloadedFixture(): void {
  const state = parseRegistryInboxState(requireEnvironment('REGISTRY_INBOX_TEST_PERSISTED_STATE'));
  verify(state.registryChainId === CHAIN_ID, 'state chain mismatch');
  verify(state.checkpoint.blockNumber === '100', 'checkpoint mismatch');
  verify(state.streamLength === 1, 'stream length mismatch');

  let streamValue: unknown;
  try {
    streamValue = JSON.parse(requireEnvironment('REGISTRY_INBOX_TEST_PERSISTED_STREAM'));
  } catch {
    throw new Error('persistence verification failed: stream is not valid JSON');
  }
  verify(Array.isArray(streamValue) && streamValue.length === 1, 'stream entry count mismatch');
  const entry = streamValue[0];
  verify(Array.isArray(entry) && entry.length === 2 && entry[0] === '100-1', 'stream ID mismatch');
  const fields = entry[1];
  verify(
    Array.isArray(fields) && fields.length === 2 && fields[0] === 'event' && typeof fields[1] === 'string',
    'stream field shape mismatch'
  );
  const envelope = parseRegistryEventEnvelope(fields[1]);
  verify(envelope.registryChainId === CHAIN_ID, 'event chain mismatch');
  verify(envelope.blockNumber === '100' && envelope.logIndex === 1, 'event position mismatch');
  verify(envelope.event.name === 'PackageOwnerChanged', 'event type mismatch');
}

/**
 * CLI phases: `wait` checks the Redis transport, `seed` destructively replaces
 * the synthetic fixture, and `verify` canonically parses state and stream data
 * reloaded after restart. `wait`/`seed` require REGISTRY_INBOX_TEST_REDIS_URL;
 * `verify` requires the persisted-state/stream variables from the shell harness.
 * CHAIN_ID must stay synchronized with that harness's literal persistence keys.
 */
async function main(): Promise<void> {
  const phase = process.argv[2];
  if (!['wait', 'seed', 'verify'].includes(phase)) {
    throw new Error('persistence verification failed: unsupported phase');
  }
  if (phase === 'verify') {
    verifyReloadedFixture();
    return;
  }

  const redisUrl = process.env.REGISTRY_INBOX_TEST_REDIS_URL;
  if (!redisUrl) throw new Error('persistence verification failed: missing REGISTRY_INBOX_TEST_REDIS_URL');

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
  } finally {
    await redis.quit();
  }
}

function failureCategory(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('persistence verification failed: ')) {
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith('Invalid registry inbox state:')) {
    return 'persisted inbox state failed canonical parsing';
  }
  if (error instanceof Error && error.message.startsWith('Invalid registry event envelope:')) {
    return 'persisted event envelope failed canonical parsing';
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) {
    return `Redis transport failed (${code})`;
  }
  return 'unexpected failure';
}

void main().catch((error: unknown) => {
  // Use only finite diagnostic categories; never echo URLs or persisted payloads.
  // eslint-disable-next-line no-console
  console.error(`registry inbox persistence probe failed: ${failureCategory(error)}`);
  process.exitCode = 1;
});
