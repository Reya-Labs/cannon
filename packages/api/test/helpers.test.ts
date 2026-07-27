/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ABI_SIGNATURE_CONFORMANCE_VECTORS,
  isAbiSignature,
  isFullPackageRef,
  isPartialPackageRef,
  parseChainIds,
  parseQueryTypes,
  parseSelectors,
  parseSelectorType,
  parseTextQuery,
} from '../src/helpers';

describe('query validation', () => {
  it('normalizes bounded, positive chain IDs', () => {
    assert.deepEqual(parseChainIds('1,10,1'), [1, 10]);
    assert.throws(() => parseChainIds('0'), /positive, safe integers/);
    assert.throws(() => parseChainIds('9007199254740992'), /positive, safe integers/);
    assert.throws(() => parseChainIds(Array.from({ length: 21 }, (_, index) => index + 1).join(',')), /at most 20/);
  });

  it('accepts only supported document types', () => {
    assert.deepEqual(parseQueryTypes('package,function,package'), ['package', 'function']);
    assert.throws(() => parseQueryTypes('event'), /unsupported document type/);
    assert.throws(() => parseQueryTypes('packages'), /unsupported document type/);
    assert.throws(() => parseQueryTypes(['package']), /Invalid types parameter/);
    assert.throws(() => parseQueryTypes('p'.repeat(129)), /Invalid types parameter/);
  });

  it('caps text queries before normalization', () => {
    assert.equal(parseTextQuery('  Package Name  '), 'package-name');
    assert.throws(() => parseTextQuery('a'.repeat(257)), /at most 256/);
    assert.throws(() => parseTextQuery(['package']), /at most 256/);
  });

  it('accepts bounded, valid selector lists and strict selector types', () => {
    assert.deepEqual(parseSelectors('0x12345678,0x12345678'), ['0x12345678']);
    assert.equal(parseSelectorType('error'), 'error');
    assert.throws(() => parseSelectors(`0x${'ab'.repeat(32)}`), /valid 4-byte selectors/);
    assert.throws(() => parseSelectors('0x1234'), /valid 4-byte selectors/);
    assert.throws(() => parseSelectors(Array.from({ length: 21 }, () => '0x12345678').join(',')), /at most 20/);
    assert.throws(() => parseSelectorType('event'), /type must be/);
    assert.throws(() => parseSelectorType('all'), /type must be/);
  });

  it('accepts only canonical printable ABI signatures', () => {
    for (const signature of ABI_SIGNATURE_CONFORMANCE_VECTORS.accepted) {
      assert.equal(isAbiSignature(signature), true);
    }
    for (const signature of [...ABI_SIGNATURE_CONFORMANCE_VECTORS.rejected, 'x'.repeat(513)]) {
      assert.equal(isAbiSignature(signature), false);
    }
  });

  it('requires full package references to satisfy the canonical field bounds', () => {
    assert.equal(isFullPackageRef('valid-package:1.2.3@main'), true);
    assert.equal(isFullPackageRef(`valid-package:${'v'.repeat(33)}@main`), false);
    assert.equal(isFullPackageRef(`valid-package:1.2.3@${'p'.repeat(25)}`), false);
  });

  it('requires partial package references to satisfy the canonical field bounds', () => {
    assert.equal(isPartialPackageRef('valid-package:1.2.3'), true);
    assert.equal(isPartialPackageRef('valid-package:1.2.3@main'), true);
    assert.equal(isPartialPackageRef(`valid-package:${'v'.repeat(33)}@main`), false);
    assert.equal(isPartialPackageRef(`valid-package:1.2.3@${'p'.repeat(25)}`), false);
  });
});
