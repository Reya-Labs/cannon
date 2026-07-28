/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { it } from 'node:test';
import { createQueue } from '../src/queue';

const REDIS_AVAILABLE = spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0;
const TEST_CID = 'QmWPYWDSbBvDu1D2S2mb3vfBT59Z3dMvwaWHKmLfpU6ABC';

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
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

it('artifact worker exits promptly when startup dependencies are unreachable', { timeout: 15_000 }, async () => {
  const healthResponse = (
    _request: unknown,
    response: { end(body: string): void; setHeader(name: string, value: string): void }
  ) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"status":"ok"}');
  };
  const source = createHttpServer(healthResponse);
  const writer = createHttpServer(healthResponse);
  const redisSockets = new Set<Socket>();
  const redisBlackhole = createNetServer((socket) => {
    redisSockets.add(socket);
    socket.once('close', () => redisSockets.delete(socket));
  });
  const sourcePort = await listen(source);
  const writerPort = await listen(writer);
  const redisPort = await listen(redisBlackhole);
  const startedAt = Date.now();
  let output = '';
  const worker = spawn(
    process.execPath,
    ['--require', 'ts-node/register/transpile-only', require.resolve('../src/worker')],
    {
      env: {
        ...process.env,
        ARTIFACT_READINESS_TIMEOUT_MS: '50',
        ARTIFACT_SOURCE_URL: `http://127.0.0.1:${sourcePort}`,
        ARTIFACT_WRITER_TOKEN: 'integration-writer-secret',
        ARTIFACT_WRITER_URL: `http://127.0.0.1:${writerPort}`,
        NODE_ENV: 'test',
        QUEUE_RETRIES: '1',
        REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  const recordOutput = (chunk: Buffer) => {
    output += chunk.toString('utf8');
  };
  worker.stdout.on('data', recordOutput);
  worker.stderr.on('data', recordOutput);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, signal] = (await Promise.race([
      once(worker, 'close'),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('artifact worker did not exit after readiness failure')), 12_000);
      }),
    ])) as [number | null, string | null];

    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.ok(Date.now() - startedAt < 12_000);
    assert.match(output, /artifact worker failed: artifact worker readiness failed/);
    assert.doesNotMatch(output, /integration-writer-secret/);
    assert.doesNotMatch(output, new RegExp(`127\\.0\\.0\\.1:(${sourcePort}|${writerPort}|${redisPort})`));
  } finally {
    if (timeout) clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
      await once(worker, 'close');
    }
    for (const socket of redisSockets) socket.destroy();
    await Promise.all([closeServer(source), closeServer(writer), closeServer(redisBlackhole)]);
  }
});
