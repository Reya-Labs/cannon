/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeRegistryEventEnvelope,
  deduplicateRegistryEventEnvelopes,
  parseRegistryEventEnvelope,
  serializeRegistryEventEnvelope,
} from '../src/registry-event-envelope';

const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TRANSACTION_HASH = `0x${'cd'.repeat(32)}`;
const PACKAGE_NAME = `0x${'11'.repeat(32)}`;
const TAG = `0x${'22'.repeat(32)}`;
const VARIANT = `0x${'33'.repeat(32)}`;
const VERSION_TAG = `0x${'44'.repeat(32)}`;
const OWNER = `0x${'55'.repeat(20)}`;
const OTHER_OWNER = `0x${'66'.repeat(20)}`;

function rawLog(eventName: string, args: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    args,
    blockHash: BLOCK_HASH,
    blockNumber: 16_490_000n,
    eventName,
    logIndex: 7,
    timestamp: 1_700_000_000n,
    transactionHash: TRANSACTION_HASH,
    ...overrides,
  };
}

function packagePublishArgs(feePaid: bigint) {
  return {
    deployUrl: 'ipfs://bafy-deploy',
    feePaid,
    metaUrl: 'ipfs://bafy-meta',
    name: PACKAGE_NAME,
    owner: OWNER,
    tag: TAG,
    variant: VARIANT,
  };
}

describe('registry event envelope', () => {
  for (const feePaid of [0n, 1n, (1n << 128n) - 1n, (1n << 256n) - 1n]) {
    it(`roundtrips bigint-backed uint256 value ${feePaid} without JSON precision loss`, () => {
      const envelope = decodeRegistryEventEnvelope(1, rawLog('PackagePublishWithFee', packagePublishArgs(feePaid)));

      const serialized = serializeRegistryEventEnvelope(envelope);
      const restored = parseRegistryEventEnvelope(serialized);

      assert.doesNotThrow(() => JSON.stringify(envelope));
      assert.deepEqual(restored, envelope);
      assert.equal(restored.event.name, 'PackagePublishWithFee');
      if (restored.event.name !== 'PackagePublishWithFee') throw new Error('unexpected event');
      assert.equal(BigInt(restored.event.feePaid), feePaid);
      assert.equal(serializeRegistryEventEnvelope(restored), serialized);
    });
  }

  it('uses immutable chain/log position as the stable duplicate identity', () => {
    const first = decodeRegistryEventEnvelope(10, rawLog('PackagePublishWithFee', packagePublishArgs(42n)));
    const replay = decodeRegistryEventEnvelope(10, rawLog('PackagePublishWithFee', packagePublishArgs(42n)));
    const nextLog = decodeRegistryEventEnvelope(
      10,
      rawLog('PackagePublishWithFee', packagePublishArgs(42n), { logIndex: 8 })
    );

    assert.equal(replay.id, first.id);
    assert.equal(first.id, `cannon-registry-event:v1:10:${BLOCK_HASH}:${TRANSACTION_HASH}:7`);
    assert.notEqual(nextLog.id, first.id);
    assert.deepEqual(deduplicateRegistryEventEnvelopes([first, replay, nextLog]), [first, nextLog]);
  });

  it('fails closed when one immutable log position has conflicting content', () => {
    const first = decodeRegistryEventEnvelope(1, rawLog('PackagePublishWithFee', packagePublishArgs(42n)));
    const conflicting = decodeRegistryEventEnvelope(
      1,
      rawLog('PackagePublishWithFee', { ...packagePublishArgs(42n), owner: OTHER_OWNER })
    );

    assert.equal(conflicting.id, first.id);
    assert.throws(() => deduplicateRegistryEventEnvelopes([first, conflicting]), /conflicting duplicate/);
  });

  it('decodes owner changes without reading a variant or tag', () => {
    const envelope = decodeRegistryEventEnvelope(
      1,
      rawLog('PackageOwnerChanged', {
        name: PACKAGE_NAME,
        owner: OWNER,
      })
    );

    assert.deepEqual(envelope.event, {
      name: 'PackageOwnerChanged',
      owner: OWNER,
      packageName: PACKAGE_NAME,
    });
    assert.equal('variant' in envelope.event, false);
    assert.equal('tag' in envelope.event, false);
  });

  it('decodes publisher changes without reading a variant or tag', () => {
    const envelope = decodeRegistryEventEnvelope(
      10,
      rawLog('PackagePublishersChanged', {
        name: PACKAGE_NAME,
        publisher: [OWNER, OTHER_OWNER],
      })
    );

    assert.deepEqual(envelope.event, {
      name: 'PackagePublishersChanged',
      packageName: PACKAGE_NAME,
      publishers: [OWNER, OTHER_OWNER],
    });
    assert.equal('variant' in envelope.event, false);
    assert.equal('tag' in envelope.event, false);
  });

  it('canonicalizes each supported event-specific payload', () => {
    const legacyPublish = decodeRegistryEventEnvelope(
      1,
      rawLog('PackagePublish', {
        deployUrl: 'ipfs://bafy-deploy',
        metaUrl: '',
        name: PACKAGE_NAME,
        owner: OWNER,
        tag: TAG,
        variant: VARIANT,
      })
    );
    const tagPublish = decodeRegistryEventEnvelope(
      1,
      rawLog('TagPublish', {
        name: PACKAGE_NAME,
        tag: TAG,
        variant: VARIANT,
        versionOfTag: VERSION_TAG,
      })
    );
    const unpublish = decodeRegistryEventEnvelope(
      10,
      rawLog('PackageUnpublish', {
        name: PACKAGE_NAME,
        owner: OWNER,
        tag: TAG,
        variant: VARIANT,
      })
    );

    assert.equal(legacyPublish.event.name, 'PackagePublish');
    if (legacyPublish.event.name !== 'PackagePublish') throw new Error('unexpected event');
    assert.equal(legacyPublish.event.feePaid, null);
    assert.deepEqual(parseRegistryEventEnvelope(serializeRegistryEventEnvelope(legacyPublish)), legacyPublish);
    assert.deepEqual(tagPublish.event, {
      name: 'TagPublish',
      packageName: PACKAGE_NAME,
      tag: TAG,
      variant: VARIANT,
      versionOfTag: VERSION_TAG,
    });
    assert.deepEqual(unpublish.event, {
      name: 'PackageUnpublish',
      owner: OWNER,
      packageName: PACKAGE_NAME,
      tag: TAG,
      variant: VARIANT,
    });
  });

  it('normalizes identity hex and addresses to a canonical lowercase form', () => {
    const envelope = decodeRegistryEventEnvelope(
      1,
      rawLog(
        'PackageOwnerChanged',
        {
          name: PACKAGE_NAME.toUpperCase().replace('0X', '0x'),
          owner: OWNER.toUpperCase().replace('0X', '0x'),
        },
        {
          blockHash: BLOCK_HASH.toUpperCase().replace('0X', '0x'),
          transactionHash: TRANSACTION_HASH.toUpperCase().replace('0X', '0x'),
        }
      )
    );

    assert.equal(envelope.blockHash, BLOCK_HASH);
    assert.equal(envelope.transactionHash, TRANSACTION_HASH);
    assert.equal(envelope.event.name, 'PackageOwnerChanged');
    if (envelope.event.name !== 'PackageOwnerChanged') throw new Error('unexpected event');
    assert.equal(envelope.event.owner, OWNER);
    assert.equal(envelope.event.packageName, PACKAGE_NAME);
  });

  it('normalizes a negative-zero log index to canonical zero', () => {
    const envelope = decodeRegistryEventEnvelope(
      1,
      rawLog('PackageOwnerChanged', { name: PACKAGE_NAME, owner: OWNER }, { logIndex: -0 })
    );

    assert.equal(Object.is(envelope.logIndex, -0), false);
    assert.equal(envelope.logIndex, 0);
    assert.equal(envelope.id, `cannon-registry-event:v1:1:${BLOCK_HASH}:${TRANSACTION_HASH}:0`);
    assert.deepEqual(parseRegistryEventEnvelope(serializeRegistryEventEnvelope(envelope)), envelope);
  });

  for (const [label, input] of [
    ['unknown event', rawLog('PackageRegistered', { name: PACKAGE_NAME })],
    [
      'owner event with publish-only fields',
      rawLog('PackageOwnerChanged', { name: PACKAGE_NAME, owner: OWNER, variant: VARIANT }),
    ],
    ['missing block hash', rawLog('PackageOwnerChanged', { name: PACKAGE_NAME, owner: OWNER }, { blockHash: null })],
    [
      'unsafe log index',
      rawLog('PackageOwnerChanged', { name: PACKAGE_NAME, owner: OWNER }, { logIndex: Number.MAX_SAFE_INTEGER + 1 }),
    ],
  ] as const) {
    it(`rejects malformed decoded input: ${label}`, () => {
      assert.throws(() => decodeRegistryEventEnvelope(1, input), /Invalid registry event envelope/);
    });
  }

  it('rejects unsupported, non-canonical and identity-mismatched serialized envelopes', () => {
    const envelope = decodeRegistryEventEnvelope(1, rawLog('PackagePublishWithFee', packagePublishArgs(42n)));
    const value = JSON.parse(serializeRegistryEventEnvelope(envelope));

    assert.throws(() => parseRegistryEventEnvelope('{'), /not valid JSON/);
    assert.throws(() => parseRegistryEventEnvelope(JSON.stringify({ ...value, version: 0 })), /unsupported version/);
    assert.throws(() => parseRegistryEventEnvelope(JSON.stringify({ ...value, id: 'forged' })), /id does not match/);
    assert.throws(
      () => parseRegistryEventEnvelope(JSON.stringify({ ...value, blockNumber: '016490000' })),
      /canonical unsigned integer string/
    );
    assert.throws(() => parseRegistryEventEnvelope(JSON.stringify({ ...value, futureField: true })), /unexpected fields/);
    assert.throws(() => parseRegistryEventEnvelope(` ${serializeRegistryEventEnvelope(envelope)}`), /not canonical/);
  });

  it('rejects an inferred fee for a legacy publish event that omitted fee data', () => {
    const legacyPublish = decodeRegistryEventEnvelope(
      1,
      rawLog('PackagePublish', {
        deployUrl: 'ipfs://bafy-deploy',
        metaUrl: '',
        name: PACKAGE_NAME,
        owner: OWNER,
        tag: TAG,
        variant: VARIANT,
      })
    );
    const value = JSON.parse(serializeRegistryEventEnvelope(legacyPublish));

    assert.throws(
      () => parseRegistryEventEnvelope(JSON.stringify({ ...value, event: { ...value.event, feePaid: '0' } })),
      /legacy event omitted fee data/
    );
  });
});
