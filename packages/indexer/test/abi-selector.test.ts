/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration is intentionally synchronous. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalAbiSelector } from '../src/abi-selector';

describe('canonical registry ABI selectors', () => {
  it('indexes functions with their canonical signature and 4-byte selector', () => {
    assert.deepEqual(
      canonicalAbiSelector({
        inputs: [],
        name: 'owner',
        outputs: [{ name: '', type: 'address' }],
        stateMutability: 'view',
        type: 'function',
      }),
      {
        selector: '0x8da5cb5b',
        signature: 'owner()',
      }
    );
  });

  it('indexes custom errors without hashing the human-readable error prefix', () => {
    assert.deepEqual(
      canonicalAbiSelector({
        inputs: [],
        name: 'Unauthorized',
        type: 'error',
      }),
      {
        selector: '0x82b42900',
        signature: 'Unauthorized()',
      }
    );
  });
});
