/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { it } from 'node:test';
import { createQueue } from '../src/queue';

const REDIS_AVAILABLE = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
const TEST_CID = 'QmWPYWDSbBvDu1D2S2mb3vfBT59Z3dMvwaWHKmLfpU6ABC';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

it(
  'registry queue enqueue completes with no artifact worker process',
  { skip: !REDIS_AVAILABLE, timeout: 10_000 },
  async () => {
    const port = await freePort();
    const redis = spawn('redis-server', ['--appendonly', 'no', '--bind', '127.0.0.1', '--port', `${port}`, '--save', '']);
    let queue: ReturnType<typeof createQueue> | undefined;

    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const onData = (chunk: Buffer) => {
            if (chunk.toString('utf8').includes('Ready to accept connections')) resolve();
          };
          redis.stdout.on('data', onData);
          redis.stderr.on('data', onData);
          redis.once('exit', (code) => reject(new Error(`redis exited before readiness: ${code}`)));
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('redis readiness timed out')), 3_000)),
      ]);

      queue = createQueue({
        QUEUE_CONCURRENCY: 1,
        QUEUE_NAME: `registry-no-worker-${process.pid}-${Date.now()}`,
        QUEUE_RETRIES: 1,
        REDIS_URL: `redis://127.0.0.1:${port}`,
      });

      await Promise.race([
        queue.add('PIN_CID', { cid: TEST_CID }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('enqueue waited for a worker')), 2_000)),
      ]);

      assert.equal(await queue.pendingCount(), 1);
    } finally {
      await queue?.close();
      redis.kill('SIGTERM');
      if (redis.exitCode === null) await once(redis, 'exit');
    }
  }
);
