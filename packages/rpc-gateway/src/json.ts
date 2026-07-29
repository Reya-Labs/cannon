import { HttpError } from './errors';

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
    return value;
  }

  private value(depth: number): unknown {
    if (depth > 64) this.invalid();
    const character = this.source[this.index];
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(depth: number): Record<string, unknown> {
    this.index++;
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index++;
      return result;
    }
    for (;;) {
      if (this.source[this.index] !== '"') this.invalid();
      const key = this.string();
      if (keys.has(key)) {
        throw new HttpError(400, 'duplicate_json_key', 'JSON objects must not contain duplicate keys');
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index++] !== ':') this.invalid();
      this.skipWhitespace();
      result[key] = this.value(depth);
      this.skipWhitespace();
      const separator = this.source[this.index++];
      if (separator === '}') return result;
      if (separator !== ',') this.invalid();
      this.skipWhitespace();
    }
  }

  private array(depth: number): unknown[] {
    this.index++;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index++;
      return result;
    }
    for (;;) {
      result.push(this.value(depth));
      this.skipWhitespace();
      const separator = this.source[this.index++];
      if (separator === ']') return result;
      if (separator !== ',') this.invalid();
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index++;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"') {
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.invalid();
        }
      }
      if (character === '\\') {
        const escaped = this.source[this.index++];
        if (escaped === 'u') {
          for (let offset = 0; offset < 4; offset++) {
            if (!/[0-9a-fA-F]/.test(this.source[this.index++])) this.invalid();
          }
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          this.invalid();
        }
      } else if (character.charCodeAt(0) < 0x20) {
        this.invalid();
      }
    }
    this.invalid();
  }

  private number(): number {
    const remaining = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remaining);
    if (!match) this.invalid();
    this.index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) this.invalid();
    return parsed;
  }

  private literal<T>(text: string, value: T): T {
    if (this.source.slice(this.index, this.index + text.length) !== text) this.invalid();
    this.index += text.length;
    return value;
  }

  private skipWhitespace(): void {
    while (' \n\r\t'.includes(this.source[this.index] ?? 'x')) this.index++;
  }

  private invalid(): never {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON without duplicate keys');
  }
}

export function parseStrictJson(body: Buffer): unknown {
  if (body.length === 0) throw new HttpError(400, 'invalid_json', 'request body must contain one JSON-RPC request');
  return new StrictJsonParser(body.toString('utf8')).parse();
}
