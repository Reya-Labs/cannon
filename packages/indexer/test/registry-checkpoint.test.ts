/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createRegistryCheckpoint,
  parseRegistryCheckpoint,
  resolveRegistryScanStart,
  serializeRegistryCheckpoint,
} from '../src/registry-checkpoint';

const BLOCK_HASH = `0x${'ab'.repeat(32)}`;

describe('registry checkpoint', () => {
  for (const blockNumber of [0n, 16_490_000n, (1n << 128n) - 1n, (1n << 256n) - 1n]) {
    it(`roundtrips block number ${blockNumber} as a canonical JSON-safe value`, () => {
      const checkpoint = createRegistryCheckpoint({
        blockHash: BLOCK_HASH,
        blockNumber,
        registryChainId: 1,
      });

      const serialized = serializeRegistryCheckpoint(checkpoint);

      assert.deepEqual(parseRegistryCheckpoint(serialized, 1), checkpoint);
      assert.equal(checkpoint.blockNumber, blockNumber.toString());
      assert.equal(serializeRegistryCheckpoint(parseRegistryCheckpoint(serialized)), serialized);
    });
  }

  it('starts cold scans at the configured inclusive boundary only when the key is absent', () => {
    assert.equal(
      resolveRegistryScanStart({
        coldStartBlock: 16_490_000n,
        registryChainId: 1,
        serializedCheckpoint: null,
      }),
      16_490_000n
    );

    assert.throws(
      () =>
        resolveRegistryScanStart({
          coldStartBlock: 16_490_000n,
          registryChainId: 1,
          serializedCheckpoint: '',
        }),
      /not valid JSON/
    );
  });

  it('resumes at checkpoint plus one instead of replaying the terminal block', () => {
    const checkpoint = createRegistryCheckpoint({
      blockHash: BLOCK_HASH,
      blockNumber: 16_495_000n,
      registryChainId: 1,
    });

    assert.equal(
      resolveRegistryScanStart({
        coldStartBlock: 16_490_000n,
        registryChainId: 1,
        serializedCheckpoint: serializeRegistryCheckpoint(checkpoint),
      }),
      16_495_001n
    );
  });

  for (const [label, serialized] of [
    ['legacy integer', '16490000'],
    ['legacy unversioned object', '{"registryChainId":1,"blockNumber":"16490000","blockHash":"' + BLOCK_HASH + '"}'],
    ['unsupported version', '{"version":0,"registryChainId":1,"blockNumber":"16490000","blockHash":"' + BLOCK_HASH + '"}'],
    ['numeric block', '{"version":1,"registryChainId":1,"blockNumber":16490000,"blockHash":"' + BLOCK_HASH + '"}'],
    ['leading-zero block', '{"version":1,"registryChainId":1,"blockNumber":"016490000","blockHash":"' + BLOCK_HASH + '"}'],
    ['invalid hash', '{"version":1,"registryChainId":1,"blockNumber":"16490000","blockHash":"0x12"}'],
    ['non-positive chain', '{"version":1,"registryChainId":0,"blockNumber":"16490000","blockHash":"' + BLOCK_HASH + '"}'],
    [
      'unknown field',
      '{"version":1,"registryChainId":1,"blockNumber":"16490000","blockHash":"' + BLOCK_HASH + '","legacy":true}',
    ],
  ] as const) {
    it(`fails closed for malformed or legacy checkpoint: ${label}`, () => {
      assert.throws(() => parseRegistryCheckpoint(serialized), /Invalid registry checkpoint/);
    });
  }

  it('rejects a checkpoint from another registry chain', () => {
    const optimismCheckpoint = createRegistryCheckpoint({
      blockHash: BLOCK_HASH,
      blockNumber: 119_000_000n,
      registryChainId: 10,
    });

    assert.throws(() => parseRegistryCheckpoint(serializeRegistryCheckpoint(optimismCheckpoint), 1), /chain mismatch/);
  });

  it('rejects a checkpoint that precedes the configured cold-start boundary', () => {
    const staleCheckpoint = createRegistryCheckpoint({
      blockHash: BLOCK_HASH,
      blockNumber: 16_489_999n,
      registryChainId: 1,
    });

    assert.throws(
      () =>
        resolveRegistryScanStart({
          coldStartBlock: 16_490_000n,
          registryChainId: 1,
          serializedCheckpoint: serializeRegistryCheckpoint(staleCheckpoint),
        }),
      /precedes cold-start boundary/
    );
  });

  it('rejects non-canonical serialization and a terminal uint256 checkpoint that cannot advance', () => {
    const checkpoint = createRegistryCheckpoint({
      blockHash: BLOCK_HASH,
      blockNumber: (1n << 256n) - 1n,
      registryChainId: 1,
    });
    const serialized = serializeRegistryCheckpoint(checkpoint);

    assert.throws(() => parseRegistryCheckpoint(` ${serialized}`), /not canonical/);
    assert.throws(
      () =>
        resolveRegistryScanStart({
          coldStartBlock: 0n,
          registryChainId: 1,
          serializedCheckpoint: serialized,
        }),
      /has no valid successor/
    );
  });
});
