/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChainIds, parseQueryTypes, parseSelectors, parseSelectorType, parseTextQuery } from '../src/helpers';

describe('query validation', () => {
  it('normalizes bounded, positive chain IDs', () => {
    assert.deepEqual(parseChainIds('1,10,1'), [1, 10]);
    assert.throws(() => parseChainIds('0'), /positive, safe integers/);
    assert.throws(() => parseChainIds('9007199254740992'), /positive, safe integers/);
    assert.throws(() => parseChainIds(Array.from({ length: 21 }, (_, index) => index + 1).join(',')), /at most 20/);
  });

  it('accepts only supported document types', () => {
    assert.deepEqual(parseQueryTypes('package,function,package'), ['package', 'function']);
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
    assert.deepEqual(parseSelectors(`0x${'ab'.repeat(32)}`), [`0x${'ab'.repeat(32)}`]);
    assert.equal(parseSelectorType('event'), 'event');
    assert.throws(() => parseSelectors('0x1234'), /valid 4-byte or 32-byte selectors/);
    assert.throws(() => parseSelectors(Array.from({ length: 21 }, () => '0x12345678').join(',')), /at most 20/);
    assert.throws(() => parseSelectorType('all'), /type must be/);
  });
});
