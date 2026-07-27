/* eslint-disable @typescript-eslint/no-floating-promises, no-console -- test registration and log interception are intentional. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errorIdentity, warnMalformedDocument } from '../src/logging';

describe('safe log identity', () => {
  it('retains bounded machine labels and rejects arbitrary detail', () => {
    assert.deepEqual(errorIdentity(Object.assign(new Error('private detail'), { code: 'ECONNREFUSED' })), {
      code: 'ECONNREFUSED',
      name: 'Error',
    });
    assert.deepEqual(
      errorIdentity({
        code: 'SENTINEL SECRET MUST NOT LEAK',
        name: 'SENTINEL/SECRET',
      }),
      {
        code: 'unexpected',
        name: 'unknown',
      }
    );
  });

  it('does not throw when an error-like object has hostile property accessors', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('SENTINEL SECRET MUST NOT LEAK');
        },
      }
    );

    assert.deepEqual(errorIdentity(hostile), { code: 'unexpected', name: 'unknown' });
  });

  it('logs only the bounded malformed-document category', () => {
    const logs: unknown[][] = [];
    const originalConsoleWarn = console.warn;
    console.warn = (...values: unknown[]) => {
      logs.push(values);
    };

    try {
      warnMalformedDocument('selector');
    } finally {
      console.warn = originalConsoleWarn;
    }

    assert.deepEqual(logs, [['query API skipped malformed Redis document', { kind: 'selector' }]]);
  });
});
