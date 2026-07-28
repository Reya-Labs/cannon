/* eslint-disable @typescript-eslint/no-floating-promises, no-console -- node:test registration and console interception are intentional. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apiErrorHandler, BadRequestError, ServerError, ServiceUnavailableError } from '../src/errors';

function captureResponse(error: unknown) {
  let body: unknown;
  let status: number | undefined;
  const response = {
    headersSent: false,
    json(value: unknown) {
      body = value;
      return response;
    },
    status(value: number) {
      status = value;
      return response;
    },
  };

  apiErrorHandler(error, undefined as never, response as never, (() => undefined) as never);
  return { body, status };
}

describe('API error boundary', () => {
  it('logs only a sanitized identity and returns a generic 5xx response', () => {
    const sentinel = 'SENTINEL_SECRET_MUST_NOT_LEAK';
    const error = Object.assign(new Error(sentinel), { code: 'E_SENTINEL', privateContext: sentinel });
    const logs: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => {
      logs.push(values);
    };

    try {
      assert.deepEqual(captureResponse(error), {
        body: { status: 500, error: 'Internal Server Error' },
        status: 500,
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.deepEqual(logs, [['query API request failed', { code: 'E_SENTINEL', name: 'Error', status: 500 }]]);
    assert.equal(JSON.stringify(logs).includes(sentinel), false);
  });

  it('uses generic bodies for explicit 502 and 503 errors while preserving safe 4xx messages', () => {
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      assert.deepEqual(captureResponse(new ServerError('private upstream details', 502)), {
        body: { status: 502, error: 'Internal Server Error' },
        status: 502,
      });
      assert.deepEqual(captureResponse(new ServiceUnavailableError('private Redis details')), {
        body: { status: 503, error: 'Service Unavailable' },
        status: 503,
      });
      assert.deepEqual(captureResponse(new BadRequestError('safe validation message')), {
        body: { status: 400, error: 'safe validation message' },
        status: 400,
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
