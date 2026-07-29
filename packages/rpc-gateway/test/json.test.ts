import { describe, expect, it } from 'vitest';
import { parseStrictJson } from '../src/json';

describe('parseStrictJson', () => {
  it('parses nested JSON without inheriting object prototypes', () => {
    const result = parseStrictJson(Buffer.from('{"jsonrpc":"2.0","params":[{"to":"0x01"}],"id":1}')) as Record<
      string,
      unknown
    >;
    expect(result.jsonrpc).toBe('2.0');
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it.each(['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', '{"a":[{"b":1,"b":2}]}'])(
    'rejects duplicate object keys: %s',
    (source) => {
      expect(() => parseStrictJson(Buffer.from(source))).toThrow('duplicate keys');
    }
  );

  it.each(['', '{"a":}', '{"a":"\\u0xx0"}', '[1,]', '{"a":NaN}', '{"a":1} trailing'])(
    'rejects invalid JSON: %s',
    (source) => {
      expect(() => parseStrictJson(Buffer.from(source))).toThrow();
    }
  );
});
