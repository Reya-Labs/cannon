import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePreviewRequest,
  parseRegistryRequest,
  PREVIEW_REQUEST_KEYS,
} from '../src/request.mjs';
import { COMMIT, PARTIAL_CID, PREVIOUS_CID, SAFE_ADDRESS } from './support.mjs';

const expected = { chainId: 1729, safeAddress: SAFE_ADDRESS };

function body(overrides = {}) {
  return JSON.stringify({
    chainId: 1729,
    commit: COMMIT,
    partialDeployCid: null,
    previousPackageCid: PREVIOUS_CID,
    safeAddress: SAFE_ADDRESS,
    ...overrides,
  });
}

function rejects(encoded, context = expected) {
  assert.throws(() => parsePreviewRequest(encoded, context), {
    code: 'INVALID_REQUEST',
  });
}

test('the request contract names immutable inputs only', () => {
  assert.deepEqual(
    [...PREVIEW_REQUEST_KEYS],
    [
      'chainId',
      'commit',
      'partialDeployCid',
      'previousPackageCid',
      'safeAddress',
    ],
  );
  for (const forbidden of [
    'safeTxHash',
    'txn',
    'nonce',
    'safeProposalCalls',
    'simulationTransactions',
    'signatures',
  ]) {
    assert.ok(!PREVIEW_REQUEST_KEYS.includes(forbidden), forbidden);
  }
});

test('accepts the canonical cannonfile request', () => {
  const parsed = parsePreviewRequest(body(), expected);
  assert.equal(parsed.deploymentMode, 'cannonfile');
  assert.equal(parsed.partialDeployCid, null);
  assert.equal(parsed.commit, COMMIT);
});

test('accepts a partial-deployment request', () => {
  const parsed = parsePreviewRequest(
    body({ partialDeployCid: PARTIAL_CID }),
    expected,
  );
  assert.equal(parsed.deploymentMode, 'partial');
  assert.equal(parsed.partialDeployCid, PARTIAL_CID);
});

test('rejects a browser-supplied preview document', () => {
  rejects(
    JSON.stringify({
      chainId: 1729,
      commit: COMMIT,
      partialDeployCid: null,
      previousPackageCid: PREVIOUS_CID,
      safeAddress: SAFE_ADDRESS,
      safeProposalCalls: [{ data: '0xdeadbeef', to: SAFE_ADDRESS, value: '0' }],
    }),
  );
});

test('rejects a browser-supplied Safe transaction or digest', () => {
  rejects(body({ safeTxHash: `0x${'1'.repeat(64)}` }));
  rejects(body({ txn: { _nonce: 7 } }));
  rejects(body({ nonce: 7 }));
});

test('rejects a foreign Safe address', () => {
  rejects(body({ safeAddress: `0x${'a'.repeat(40)}` }));
});

test('rejects a foreign chain', () => {
  rejects(body({ chainId: 1 }));
  rejects(body({ chainId: '1729' }));
});

test('rejects a malformed commit or CID', () => {
  rejects(body({ commit: COMMIT.toUpperCase() }));
  rejects(body({ commit: COMMIT.slice(0, 39) }));
  rejects(body({ previousPackageCid: 'Qmnot-a-cid' }));
  rejects(body({ partialDeployCid: 'bafybeiexample' }));
});

test('rejects a partial deployment that repeats the previous package', () => {
  rejects(body({ partialDeployCid: PREVIOUS_CID }));
});

test('rejects reordered keys, duplicates and padding', () => {
  rejects(
    JSON.stringify({
      commit: COMMIT,
      chainId: 1729,
      partialDeployCid: null,
      previousPackageCid: PREVIOUS_CID,
      safeAddress: SAFE_ADDRESS,
    }),
  );
  rejects(`  ${body()}`);
  rejects(body().replace('"chainId":1729', '"chainId":1729 '));
  rejects(
    `{"chainId":1729,"chainId":1729,"commit":"${COMMIT}","partialDeployCid":null,"previousPackageCid":"${PREVIOUS_CID}","safeAddress":"${SAFE_ADDRESS}"}`,
  );
});

test('rejects prototype pollution attempts', () => {
  // `JSON.parse` defines `__proto__` as an own property, so the exact-key check
  // is what rejects it — an object literal would silently set the prototype
  // instead and never produce this byte sequence.
  rejects(
    `{"__proto__":{"a":1},"chainId":1729,"commit":"${COMMIT}","partialDeployCid":null,"previousPackageCid":"${PREVIOUS_CID}","safeAddress":"${SAFE_ADDRESS}"}`,
  );
  rejects(
    `{"chainId":1729,"commit":"${COMMIT}","constructor":{"a":1},"partialDeployCid":null,"previousPackageCid":"${PREVIOUS_CID}","safeAddress":"${SAFE_ADDRESS}"}`,
  );
});

test('rejects non-object and oversized documents', () => {
  rejects('null');
  rejects('[]');
  rejects('"preview"');
  rejects('{');
  rejects(JSON.stringify({ ...JSON.parse(body()), commit: 'a'.repeat(2_000) }));
});

test('resolves only the exact reya-omnibus alias family', () => {
  assert.equal(
    parseRegistryRequest(
      JSON.stringify({ chainId: 1729, packageRef: 'reya-omnibus:latest@main' }),
      { chainId: 1729 },
    ).packageRef,
    'reya-omnibus:latest@main',
  );
  assert.equal(
    parseRegistryRequest(
      JSON.stringify({ chainId: 1729, packageRef: 'reya-omnibus:1.2.3@main' }),
      { chainId: 1729 },
    ).packageRef,
    'reya-omnibus:1.2.3@main',
  );
  for (const packageRef of [
    'other-package:latest@main',
    'reya-omnibus:latest@dev',
    'reya-omnibus:latest',
    'reya-omnibus:latest@main ',
    '../reya-omnibus:latest@main',
  ]) {
    assert.throws(
      () =>
        parseRegistryRequest(JSON.stringify({ chainId: 1729, packageRef }), {
          chainId: 1729,
        }),
      { code: 'INVALID_REQUEST' },
      packageRef,
    );
  }
});
