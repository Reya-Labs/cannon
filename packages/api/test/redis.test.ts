/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { checkRedisClientReadiness, createRedisLifecycle } from '../src/redis';

class FakeRedisClient extends EventEmitter {
  connectFailure: Error | undefined;
  connectGate: Promise<void> | undefined;
  connectCalls = 0;
  disconnectCalls = 0;
  isOpen = false;
  isReady = false;

  async connect() {
    this.connectCalls += 1;
    this.isOpen = true;
    if (this.connectGate) await this.connectGate;
    if (this.connectFailure) {
      const error = this.connectFailure;
      this.connectFailure = undefined;
      this.isOpen = false;
      throw error;
    }
    this.isReady = true;
    this.emit('ready');
  }

  async disconnect() {
    this.disconnectCalls += 1;
    this.isOpen = false;
    this.isReady = false;
    this.emit('end');
  }
}

describe('Redis readiness', () => {
  it('requires connectivity and both canonical search indexes', async () => {
    const operations: string[] = [];
    const controller = new AbortController();
    await checkRedisClientReadiness(
      {
        ft: {
          info: async (options, index) => {
            assert.equal(options.signal, controller.signal);
            operations.push(`FT.INFO ${index}`);
          },
        },
        ping: async (options) => {
          assert.equal(options.signal, controller.signal);
          operations.push('PING');
        },
      },
      controller.signal
    );

    assert.deepEqual(operations.sort(), ['FT.INFO reg:abi', 'FT.INFO reg:packages', 'PING']);
  });

  it('fails readiness when a canonical search index is unavailable', async () => {
    await assert.rejects(
      checkRedisClientReadiness(
        {
          ft: {
            info: async (_options, index) => {
              if (index === 'reg:abi') throw new Error('Unknown index name');
            },
          },
          ping: async () => undefined,
        },
        new AbortController().signal
      ),
      /Unknown index name/
    );
  });

  it('coalesces initial connection attempts and waits for a reconnecting socket to become ready', async () => {
    const redis = new FakeRedisClient();
    const lifecycle = createRedisLifecycle(redis);
    let releaseConnect: () => void = () => undefined;
    redis.connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });

    const firstConnect = lifecycle.connect();
    const secondConnect = lifecycle.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(redis.connectCalls, 1);
    assert.equal(redis.isReady, false);
    releaseConnect();
    await Promise.all([firstConnect, secondConnect]);

    redis.isReady = false;
    const reconnect = lifecycle.connect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(redis.connectCalls, 1, 'must not call connect() again while the socket is already open');

    redis.isReady = true;
    redis.emit('ready');
    await reconnect;

    await lifecycle.disconnect();
    assert.equal(redis.disconnectCalls, 1);
  });

  it('clears rejected connection attempts so a later call can retry', async () => {
    const redis = new FakeRedisClient();
    const lifecycle = createRedisLifecycle(redis);
    redis.connectFailure = new Error('connection failed');

    await assert.rejects(lifecycle.connect(), /connection failed/);
    await lifecycle.connect();

    assert.equal(redis.connectCalls, 2);
    assert.equal(redis.isReady, true);
  });
});
