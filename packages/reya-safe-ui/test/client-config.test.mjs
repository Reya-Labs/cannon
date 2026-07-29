import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReyaReadOnlyClients,
  REYA_CHAIN_ID,
  REYA_READ_LIMITS,
  ReyaReadClientError,
} from '../src/clients/index.mjs';
import {
  DEPLOY_CID,
  SERVICE_ORIGIN,
  verifyAbiSelector,
} from '../test-support/client-fixtures.mjs';

function validOptions() {
  return {
    fetchImpl: async () => {
      throw new Error('unused');
    },
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async () => DEPLOY_CID,
  };
}

function assertConfigurationRejected(callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, 'INVALID_CONFIGURATION');
    assert.equal(error.message, 'Read client configuration is invalid.');
    assert.doesNotMatch(error.message, /cannon-api|credential|token/i);
    return true;
  });
}

test('creates an immutable read-only client fixed to Reya chain 1729', () => {
  const client = createReyaReadOnlyClients(validOptions());

  assert.equal(client.chainId, REYA_CHAIN_ID);
  assert.equal(client.chainId, 1729);
  assert.equal(client.serviceOrigin, SERVICE_ORIGIN);
  assert.ok(Object.isFrozen(client));
  assert.ok(Object.isFrozen(client.query));
  assert.ok(Object.isFrozen(client.artifacts));
  assert.ok(Object.isFrozen(client.rpc));
  assert.ok(Object.isFrozen(client.source));
  assert.deepEqual(Object.keys(client.query).sort(), [
    'chains',
    'packageByRef',
    'packagesByName',
    'search',
    'selector',
  ]);
  assert.deepEqual(Object.keys(client.artifacts), ['cat']);
  assert.deepEqual(Object.keys(client.rpc), ['read']);
  assert.deepEqual(Object.keys(client.source), ['bundle']);
});

for (const serviceOrigin of [
  'http://cannon-api.reya-tailnet.ts.net',
  'https://cannon-api.reya-tailnet.ts.net/',
  'https://CANNON-api.reya-tailnet.ts.net',
  'https://cannon-api.reya-tailnet.ts.net:443',
  'https://cannon-api.reya-tailnet.ts.net:8443',
  'https://user@cannon-api.reya-tailnet.ts.net',
  'https://user:password@cannon-api.reya-tailnet.ts.net',
  'https://cannon-api.reya-tailnet.ts.net/query',
  'https://cannon-api.reya-tailnet.ts.net?route=query',
  'https://cannon-api.reya-tailnet.ts.net#query',
  'https://cannon-api.example.com',
  'https://reya-tailnet.ts.net',
  'https://127.0.0.1',
  'not a URL',
  '',
]) {
  test(`rejects non-canonical or non-Tailscale origin ${serviceOrigin}`, () => {
    assertConfigurationRejected(() =>
      createReyaReadOnlyClients({
        ...validOptions(),
        serviceOrigin,
      })
    );
  });
}

test('rejects missing integrity verification and transport dependencies', () => {
  for (const verifier of ['verifyAbiSelector', 'verifyArtifactCid']) {
    const options = validOptions();
    delete options[verifier];
    assertConfigurationRejected(() => createReyaReadOnlyClients(options));
  }

  assertConfigurationRejected(() =>
    createReyaReadOnlyClients({
      ...validOptions(),
      fetchImpl: 'fetch',
    })
  );

  assertConfigurationRejected(() =>
    createReyaReadOnlyClients({
      ...validOptions(),
      verifyAbiSelector: 'verify',
    })
  );
});

test('rejects symbol-keyed and inherited configuration', () => {
  const symbolKeyed = validOptions();
  symbolKeyed[Symbol('bearerToken')] = 'secret';
  assertConfigurationRejected(() => createReyaReadOnlyClients(symbolKeyed));

  assertConfigurationRejected(() =>
    createReyaReadOnlyClients(Object.create(validOptions()))
  );
});

for (const extra of [
  { authorization: 'secret' },
  { bearerToken: 'secret' },
  { credentials: 'include' },
  { fallbackOrigin: 'https://fallback.example' },
  { ipfsGateway: 'https://gateway.example' },
  { rpcUrl: 'https://rpc.example' },
]) {
  test(`rejects unreviewed client option ${Object.keys(extra)[0]}`, () => {
    assertConfigurationRejected(() =>
      createReyaReadOnlyClients({ ...validOptions(), ...extra })
    );
  });
}

test('allows only bounded deadline reductions with both values explicit', () => {
  assert.doesNotThrow(() =>
    createReyaReadOnlyClients({
      ...validOptions(),
      deadlines: {
        artifactDeadlineMs: 25,
        queryDeadlineMs: 10,
        rpcDeadlineMs: 15,
      },
    })
  );

  for (const deadlines of [
    {},
    { artifactDeadlineMs: 10 },
    { queryDeadlineMs: 10 },
    {
      artifactDeadlineMs: REYA_READ_LIMITS.artifactDeadlineMs + 1,
      queryDeadlineMs: 10,
    },
    {
      artifactDeadlineMs: 10,
      queryDeadlineMs: REYA_READ_LIMITS.queryDeadlineMs + 1,
    },
    {
      artifactDeadlineMs: 10,
      queryDeadlineMs: 10,
      rpcDeadlineMs: REYA_READ_LIMITS.rpcDeadlineMs + 1,
    },
    { artifactDeadlineMs: 0, queryDeadlineMs: 10 },
    { artifactDeadlineMs: 10, queryDeadlineMs: 1.5 },
    {
      artifactDeadlineMs: 10,
      queryDeadlineMs: 10,
      timeoutFallback: true,
    },
  ]) {
    assertConfigurationRejected(() =>
      createReyaReadOnlyClients({ ...validOptions(), deadlines })
    );
  }
});
