import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createReyaStagingClient,
  REYA_CHAIN_ID,
  REYA_STAGING_LIMITS,
  ReyaReadClientError,
  ReyaStagingServiceError,
  STAGING_ROUTE_PREFIX,
} from '../src/clients/index.mjs';
import {
  jsonResponse,
  SAFE_ADDRESS,
  SERVICE_ORIGIN,
} from '../test-support/client-fixtures.mjs';

const SIGNATURE = `0x${'11'.repeat(64)}1b`;
const OTHER_SIGNATURE = `0x${'22'.repeat(64)}1c`;
const DIGEST = `0x${'ab'.repeat(32)}`;
const TRANSACTION = Object.freeze({
  _nonce: 7,
  baseGas: '0',
  data: '0x1234',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  operation: '0',
  refundReceiver: SAFE_ADDRESS,
  safeTxGas: '0',
  to: '0x2222222222222222222222222222222222222222',
  value: '0',
});

function proposal(overrides = {}) {
  return {
    createdAt: 1_700_000_000_000,
    sigs: [SIGNATURE],
    txn: { ...TRANSACTION },
    updatedAt: 1_700_000_000_001,
    ...overrides,
  };
}

function clientWith(fetchImpl, overrides = {}) {
  return createReyaStagingClient({
    fetchImpl,
    safeAddress: SAFE_ADDRESS,
    serviceOrigin: SERVICE_ORIGIN,
    ...overrides,
  });
}

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('reads only the current proposal from the fixed Reya staging route', async () => {
  const requests = [];
  const responses = [[], [proposal()]];
  const client = clientWith(async (url, options) => {
    requests.push({ options, url });
    return jsonResponse(responses.shift());
  });

  assert.equal(client.chainId, REYA_CHAIN_ID);
  assert.equal(client.safeAddress, SAFE_ADDRESS);
  assert.equal(client.serviceOrigin, SERVICE_ORIGIN);
  assert.equal(await client.current(), null);
  const current = await client.current();

  assert.deepEqual(current, proposal());
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(current.sigs));
  assert.ok(Object.isFrozen(current.txn));
  for (const { options, url } of requests) {
    assert.equal(
      url,
      `${SERVICE_ORIGIN}${STAGING_ROUTE_PREFIX}/${REYA_CHAIN_ID}/${SAFE_ADDRESS}`
    );
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal('body' in options, false);
  }
});

test('submits exactly one canonical current-owner signature without attestation or target overrides', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => {
    requests.push({ options, url });
    return jsonResponse([proposal()], { status: 201 });
  });

  const result = await client.submitSignature({
    signature: SIGNATURE,
    txn: TRANSACTION,
  });

  assert.equal(result.created, true);
  assert.deepEqual(result.proposal, proposal());
  assert.ok(Object.isFrozen(result));
  assert.equal(requests.length, 1);
  const [{ options, url }] = requests;
  assert.equal(
    url,
    `${SERVICE_ORIGIN}${STAGING_ROUTE_PREFIX}/${REYA_CHAIN_ID}/${SAFE_ADDRESS}`
  );
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.deepEqual(options.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  assert.deepEqual(JSON.parse(options.body), {
    sigs: [SIGNATURE],
    txn: TRANSACTION,
  });
  assert.deepEqual(Object.keys(JSON.parse(options.body)), ['sigs', 'txn']);
});

test('returns created false when the backend atomically merges a signature', async () => {
  const merged = proposal({ sigs: [SIGNATURE, OTHER_SIGNATURE] });
  const client = clientWith(async () =>
    jsonResponse([merged], { status: 200 })
  );

  const result = await client.submitSignature({
    signature: SIGNATURE,
    txn: TRANSACTION,
  });

  assert.equal(result.created, false);
  assert.deepEqual(result.proposal, merged);
});

test('supersedes only the fixed proposal with an explicit idempotency key', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => {
    requests.push({ options, url });
    return jsonResponse({ digest: DIGEST, status: 'superseded' });
  });

  const result = await client.supersede({
    expectedDigest: DIGEST,
    idempotencyKey: 'reviewed-replacement-0001',
    reason: 'Reviewed replacement required',
  });

  assert.deepEqual(result, { digest: DIGEST, status: 'superseded' });
  assert.ok(Object.isFrozen(result));
  const [{ options, url }] = requests;
  assert.equal(
    url,
    `${SERVICE_ORIGIN}${STAGING_ROUTE_PREFIX}/${REYA_CHAIN_ID}/${SAFE_ADDRESS}/supersede`
  );
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Idempotency-Key': 'reviewed-replacement-0001',
  });
  assert.deepEqual(JSON.parse(options.body), {
    expectedDigest: DIGEST,
    reason: 'Reviewed replacement required',
  });
});

test('exposes only an allowlisted service code and status for controlled backend rejections', async () => {
  const client = clientWith(async () =>
    jsonResponse(
      {
        error: {
          code: 'stale_or_future_nonce',
          details: { currentNonce: 8, proposedNonce: 7 },
          message: 'sensitive upstream wording',
        },
      },
      { status: 409 }
    )
  );

  await assert.rejects(
    () =>
      client.submitSignature({
        signature: SIGNATURE,
        txn: TRANSACTION,
      }),
    (error) => {
      assert.ok(error instanceof ReyaStagingServiceError);
      assert.ok(error instanceof ReyaReadClientError);
      assert.equal(error.code, 'SERVICE_REJECTED');
      assert.equal(error.httpStatus, 409);
      assert.equal(error.serviceCode, 'stale_or_future_nonce');
      assert.equal(
        error.message,
        'The Reya staging service rejected the request.'
      );
      assert.equal(error.message.includes('sensitive'), false);
      assert.equal('details' in error, false);
      return true;
    }
  );
});

test('rejects unknown or status-confused backend error envelopes', async () => {
  const responses = [
    jsonResponse(
      { error: { code: 'attacker_code', message: 'blocked' } },
      { status: 409 }
    ),
    jsonResponse(
      { error: { code: 'unauthenticated', message: 'blocked' } },
      { status: 409 }
    ),
    jsonResponse(
      {
        error: {
          code: 'stale_or_future_nonce',
          message: 'blocked',
          secret: 'unexpected',
        },
      },
      { status: 409 }
    ),
  ];
  const client = clientWith(async () => responses.shift());

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      () => client.current(),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('does not retry a staging mutation after an ambiguous network failure', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('ambiguous write result');
  });

  await assert.rejects(
    () =>
      client.submitSignature({
        signature: SIGNATURE,
        txn: TRANSACTION,
      }),
    assertClientError('REQUEST_FAILED')
  );
  assert.equal(calls, 1);
});

test('rejects configurable targets, credentials, unknown options, and unsafe origins before fetch', () => {
  for (const overrides of [
    { authorization: 'secret' },
    { chainId: 1 },
    { deadlineMs: REYA_STAGING_LIMITS.deadlineMs + 1 },
    { safeAddress: '0x0000000000000000000000000000000000000000' },
    { safeAddress: SAFE_ADDRESS.toUpperCase() },
    { serviceOrigin: 'https://example.com' },
    { serviceOrigin: `${SERVICE_ORIGIN}/path` },
    { serviceOrigin: `${SERVICE_ORIGIN}?token=secret` },
  ]) {
    assert.throws(
      () => clientWith(() => undefined, overrides),
      assertClientError('INVALID_CONFIGURATION')
    );
  }
});

test('rejects accessor-backed configuration and mutation input without invoking accessors', async () => {
  let reads = 0;
  const options = {
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
    safeAddress: SAFE_ADDRESS,
    serviceOrigin: SERVICE_ORIGIN,
  };
  Object.defineProperty(options, 'safeAddress', {
    enumerable: true,
    get() {
      reads += 1;
      return SAFE_ADDRESS;
    },
  });
  assert.throws(
    () => createReyaStagingClient(options),
    assertClientError('INVALID_CONFIGURATION')
  );
  assert.equal(reads, 0);

  const client = clientWith(async () => {
    throw new Error('must not fetch');
  });
  const input = { signature: SIGNATURE };
  Object.defineProperty(input, 'txn', {
    enumerable: true,
    get() {
      reads += 1;
      return TRANSACTION;
    },
  });
  await assert.rejects(
    () => client.submitSignature(input),
    assertClientError('INVALID_INPUT')
  );
  assert.equal(reads, 0);
});

test('rejects malformed mutation inputs before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('must not fetch');
  });
  const symbolInput = { signature: SIGNATURE, txn: TRANSACTION };
  symbolInput[Symbol('credential')] = 'secret';

  for (const input of [
    null,
    symbolInput,
    { signature: `${SIGNATURE.slice(0, -2)}00`, txn: TRANSACTION },
    { signature: SIGNATURE, txn: { ...TRANSACTION, _nonce: -1 } },
    { signature: SIGNATURE, txn: { ...TRANSACTION, operation: '2' } },
    { signature: SIGNATURE, txn: { ...TRANSACTION, data: '0xABCDEF' } },
    { signature: SIGNATURE, txn: { ...TRANSACTION, value: '01' } },
    {
      signature: SIGNATURE,
      txn: {
        ...TRANSACTION,
        value: (1n << 256n).toString(),
      },
    },
    {
      signature: SIGNATURE,
      txn: { ...TRANSACTION, url: 'https://rpc.example' },
    },
  ]) {
    await assert.rejects(
      () => client.submitSignature(input),
      assertClientError('INVALID_INPUT')
    );
  }

  for (const input of [
    {
      expectedDigest: DIGEST.toUpperCase(),
      idempotencyKey: 'reviewed-replacement-0001',
      reason: 'Reviewed replacement required',
    },
    {
      expectedDigest: DIGEST,
      idempotencyKey: 'short',
      reason: 'Reviewed replacement required',
    },
    {
      expectedDigest: DIGEST,
      idempotencyKey: 'reviewed-replacement-0001',
      reason: ' padded reason ',
    },
  ]) {
    await assert.rejects(
      () => client.supersede(input),
      assertClientError('INVALID_INPUT')
    );
  }
  assert.equal(calls, 0);
});

test('binds successful staging responses to the submitted transaction and signature', async () => {
  const responses = [
    jsonResponse([], { status: 201 }),
    jsonResponse(
      [proposal({ txn: { ...TRANSACTION, _nonce: 8 } })],
      { status: 201 }
    ),
    jsonResponse(
      [proposal({ sigs: [OTHER_SIGNATURE] })],
      { status: 201 }
    ),
    jsonResponse([proposal(), proposal()], { status: 201 }),
  ];
  const client = clientWith(async () => responses.shift());

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(
      () =>
        client.submitSignature({
          signature: SIGNATURE,
          txn: TRANSACTION,
        }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('rejects non-canonical, duplicate-key, oversized, and malformed success responses', async () => {
  const duplicate =
    `[{"createdAt":1,"sigs":["${SIGNATURE}"],` +
    `"txn":${JSON.stringify(TRANSACTION)},` +
    '"updatedAt":2,"updatedAt":3}]';
  const responses = [
    jsonResponse(` ${JSON.stringify([proposal()])}`, {
      contentLength: false,
    }),
    jsonResponse(duplicate, { contentLength: false }),
    jsonResponse([proposal({ updatedAt: 1 })]),
    jsonResponse([proposal({ sigs: [SIGNATURE, SIGNATURE] })]),
    jsonResponse([proposal()], {
      headers: {
        'content-length': String(REYA_STAGING_LIMITS.responseBytes + 1),
      },
    }),
  ];
  const client = clientWith(async () => responses.shift());

  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(
      () => client.current(),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('normalizes mixed-case backend hex without weakening canonical mutation input', async () => {
  const mixed = proposal({
    sigs: [SIGNATURE.toUpperCase().replace('0X', '0x')],
    txn: {
      ...TRANSACTION,
      data: '0xABCD',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa',
      to: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
    },
  });
  const client = clientWith(async () => jsonResponse([mixed]));

  const current = await client.current();

  assert.equal(current.sigs[0], SIGNATURE);
  assert.equal(current.txn.data, '0xabcd');
  assert.equal(
    current.txn.refundReceiver,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  );
  assert.equal(
    current.txn.to,
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  );
});

test('rejects a supersession response that is not bound to the requested digest', async () => {
  const client = clientWith(async () =>
    jsonResponse({
      digest: `0x${'cd'.repeat(32)}`,
      status: 'superseded',
    })
  );

  await assert.rejects(
    () =>
      client.supersede({
        expectedDigest: DIGEST,
        idempotencyKey: 'reviewed-replacement-0001',
        reason: 'Reviewed replacement required',
      }),
    assertClientError('RESPONSE_REJECTED')
  );
});
