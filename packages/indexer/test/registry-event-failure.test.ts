/* eslint-disable @typescript-eslint/no-floating-promises, no-console -- node:test registration is synchronous and console capture verifies redaction. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as rkey from '../src/db';
import {
  handleRegistryEventFailure,
  reportRegistryFailure,
  UnsupportedRegistryEventError,
} from '../src/registry-event-failure';

describe('registry event failure disposition', () => {
  it('propagates unsupported event kinds without dead-lettering them', async () => {
    const pushed: unknown[] = [];
    const error = new UnsupportedRegistryEventError('unsupported registry event');

    await assert.rejects(
      handleRegistryEventFailure(
        error,
        { eventName: 'UnexpectedEvent' },
        {
          async lPush(...args) {
            pushed.push(args);
            return 1;
          },
        }
      ),
      (caught: unknown) => caught === error
    );
    assert.deepEqual(pushed, []);
  });

  it('dead-letters processing failures without logging raw errors or payloads', async () => {
    const logs: unknown[][] = [];
    const pushed: Array<[string, string]> = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      await handleRegistryEventFailure(
        new Error('redis://user:secret@redis.example.com sensitive payload'),
        { eventName: 'PackagePublish', feePaid: 1n } as { eventName: string },
        {
          async lPush(key, value) {
            pushed.push([key, value]);
            return 1;
          },
        }
      );
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(logs, [['[REG] failed to process PackagePublish event (Error)']]);
    assert.equal(JSON.stringify(logs).includes('secret'), false);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0][0], rkey.RKEY_RETRY_PROCESS_PACKAGE);
    assert.deepEqual(JSON.parse(pushed[0][1]), { eventName: 'PackagePublish', feePaid: '1' });
  });

  it('keeps process and dependency diagnostics free of credential-bearing errors', () => {
    const logs: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      const secretError = new Error('https://mainnet.example.com/v3/provider-secret redis://user:password@redis');
      reportRegistryFailure('process', secretError);
      reportRegistryFailure('scan', secretError);
      reportRegistryFailure('notification', secretError);
      reportRegistryFailure('action', secretError);
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(logs, [
      ['registry process failed'],
      ['failure while scanning cannon publishes'],
      ['[warn] registry notification failed'],
      ['[warn] registry action handler failed'],
    ]);
    assert.equal(JSON.stringify(logs).includes('provider-secret'), false);
    assert.equal(JSON.stringify(logs).includes('password'), false);
  });
});
