/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRedisClientReadiness } from '../src/redis';

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
});
