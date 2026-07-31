import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTES } from '../src/app.mjs';
import {
  authHeaders,
  ENV,
  PARTIAL_CID,
  PREVIOUS_CID,
  previewBody,
  SAFE_ADDRESS,
  UI_ORIGIN,
  withServer,
} from './support.mjs';

const json = { 'content-type': 'application/json' };

test('exposes only the preview and registry routes', () => {
  assert.deepEqual(
    ROUTES.map(({ method, path }) => `${method} ${path}`),
    ['POST /preview/1729', 'POST /registry/op/resolve'],
  );
});

test('never exposes an execution, signing or broadcast route', async () => {
  await withServer({}, async ({ request }) => {
    for (const path of [
      '/execute/1729',
      '/preview/1729/execute',
      '/staging/1729/' + SAFE_ADDRESS,
      '/rpc/1729',
      '/sign',
      '/broadcast',
    ]) {
      const response = await request(path, {
        body: '{}',
        headers: authHeaders(),
        method: 'POST',
      });
      assert.equal(response.status, 404, path);
      assert.equal(response.json().error.code, 'NOT_FOUND', path);
    }
  });
});

test('rejects a foreign browser origin before authenticating', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders({ origin: 'https://cannon.reya.xyz.evil.example' }),
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.equal(response.json().error.code, 'ORIGIN_FORBIDDEN');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  });
});

test('rejects a missing browser origin', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: { ...json, 'x-reya-user': 'signer@reya.xyz' },
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.equal(response.json().error.code, 'ORIGIN_FORBIDDEN');
  });
});

test('reflects exactly the configured UI origin and never a wildcard', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders(),
      method: 'POST',
    });
    assert.equal(response.headers['access-control-allow-origin'], UI_ORIGIN);
    assert.equal(response.headers['vary'], 'Origin');
    assert.equal(
      response.headers['access-control-allow-credentials'],
      undefined,
    );
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

test('rejects an unauthenticated request', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: { ...json, origin: UI_ORIGIN },
      method: 'POST',
    });
    assert.equal(response.status, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');
  });
});

test('rejects a forged proxy secret', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders({ 'x-reya-proxy-secret': 'z'.repeat(48) }),
      method: 'POST',
    });
    assert.equal(response.status, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');
  });
});

test('rejects a duplicated identity header instead of folding it', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders(),
      method: 'POST',
      rawHeaderLines: [['x-reya-user', ['first@reya.xyz', 'second@reya.xyz']]],
    });
    assert.equal(response.status, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');
  });
});

test('rejects an unknown application role', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders({ 'x-reya-roles': 'executor' }),
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.equal(response.json().error.code, 'FORBIDDEN');
  });
});

test('rejects a non-JSON media type', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders({ 'content-type': 'text/plain' }),
      method: 'POST',
    });
    assert.equal(response.status, 415);
  });
});

test('rejects a compressed body', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody(),
      headers: authHeaders({ 'content-encoding': 'gzip' }),
      method: 'POST',
    });
    assert.equal(response.status, 415);
  });
});

test('rejects an oversized preview body', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729', {
      body: previewBody({ commit: 'a'.repeat(4_000) }),
      headers: authHeaders(),
      method: 'POST',
    });
    assert.equal(response.status, 413);
    assert.equal(response.json().error.code, 'BODY_TOO_LARGE');
  });
});

test('rejects GET and DELETE on the preview route', async () => {
  await withServer({}, async ({ request }) => {
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const response = await request('/preview/1729', {
        headers: authHeaders(),
        method,
      });
      assert.equal(response.status, 405, method);
      assert.equal(response.json().error.code, 'METHOD_NOT_ALLOWED', method);
    }
  });
});

test('rejects a query string on an exact route', async () => {
  await withServer({}, async ({ request }) => {
    const response = await request('/preview/1729?trace=1', {
      body: previewBody(),
      headers: authHeaders(),
      method: 'POST',
    });
    assert.equal(response.status, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  });
});

test('answers a preflight only for an exact allowed route and header', async () => {
  await withServer({}, async ({ request }) => {
    const allowed = await request('/preview/1729', {
      headers: {
        'access-control-request-headers': 'content-type',
        'access-control-request-method': 'POST',
        origin: UI_ORIGIN,
      },
      method: 'OPTIONS',
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers['access-control-allow-origin'], UI_ORIGIN);

    const forbiddenHeader = await request('/preview/1729', {
      headers: {
        'access-control-request-headers': 'content-type,x-reya-user',
        'access-control-request-method': 'POST',
        origin: UI_ORIGIN,
      },
      method: 'OPTIONS',
    });
    assert.equal(forbiddenHeader.status, 403);

    const forbiddenRoute = await request('/execute/1729', {
      headers: {
        'access-control-request-method': 'POST',
        origin: UI_ORIGIN,
      },
      method: 'OPTIONS',
    });
    assert.equal(forbiddenRoute.status, 404);
  });
});

test('serves health probes without an origin or identity', async () => {
  await withServer({}, async ({ request }) => {
    for (const path of ['/livez', '/readyz']) {
      const response = await request(path, { method: 'GET' });
      assert.equal(response.status, 200, path);
      assert.deepEqual(response.json(), { status: 'ok' });
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  });
});

test('never leaks upstream detail in an error body', async () => {
  await withServer(
    {
      previewRunner: {
        run: async () => {
          throw new Error(
            'connect ECONNREFUSED https://rpc.example.invalid/v1/supersecrettoken',
          );
        },
      },
    },
    async ({ request }) => {
      const response = await request('/preview/1729', {
        body: previewBody(),
        headers: authHeaders(),
        method: 'POST',
      });
      assert.equal(response.status, 502);
      assert.deepEqual(response.json(), {
        error: { code: 'UPSTREAM_UNAVAILABLE' },
      });
      assert.ok(!response.body.includes('supersecrettoken'));
      assert.ok(!response.body.includes('rpc.example.invalid'));
    },
  );
});

test('passes only the validated immutable request to the runner', async () => {
  let seen;
  await withServer(
    {
      previewRunner: {
        run: async (parsed) => {
          seen = parsed;
          return { ok: true };
        },
      },
    },
    async ({ request }) => {
      const response = await request('/preview/1729', {
        body: previewBody({ partialDeployCid: PARTIAL_CID }),
        headers: authHeaders(),
        method: 'POST',
      });
      assert.equal(response.status, 200);
    },
  );
  assert.deepEqual(Object.keys(seen).sort(), [
    'chainId',
    'commit',
    'deploymentMode',
    'partialDeployCid',
    'previousPackageCid',
    'safeAddress',
  ]);
  assert.equal(seen.deploymentMode, 'partial');
  assert.equal(seen.partialDeployCid, PARTIAL_CID);
  assert.equal(seen.previousPackageCid, PREVIOUS_CID);
  assert.equal(seen.safeAddress, ENV.PREVIEW_SAFE_ADDRESS);
});
