import { randomUUID } from 'node:crypto';
import { QuorumError } from './errors';
import { parseStrictJson } from './json';

export type UpstreamOutcome = { kind: 'result'; result: unknown } | { code: number; data?: string; kind: 'error' };

type Fetch = typeof fetch;

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const advertised = response.headers.get('content-length');
  if (advertised && (!/^[0-9]+$/.test(advertised) || Number(advertised) > maximumBytes)) {
    throw new QuorumError('oversized_response');
  }
  if (!response.body) throw new QuorumError('empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new QuorumError('oversized_response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

function decodeResponse(value: unknown, expectedId: string): UpstreamOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuorumError('malformed_response');
  }
  const decoded = value as Record<string, unknown>;
  if (decoded.jsonrpc !== '2.0' || decoded.id !== expectedId) {
    throw new QuorumError('malformed_response');
  }
  const keys = Object.keys(decoded);
  if ('result' in decoded && !('error' in decoded) && keys.every((key) => ['id', 'jsonrpc', 'result'].includes(key))) {
    return { kind: 'result', result: decoded.result };
  }
  if ('error' in decoded && !('result' in decoded) && keys.every((key) => ['error', 'id', 'jsonrpc'].includes(key))) {
    if (typeof decoded.error !== 'object' || decoded.error === null || Array.isArray(decoded.error)) {
      throw new QuorumError('malformed_response');
    }
    const error = decoded.error as Record<string, unknown>;
    if (!Number.isSafeInteger(error.code)) throw new QuorumError('malformed_response');
    if (error.data !== undefined && (typeof error.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(error.data))) {
      throw new QuorumError('malformed_response');
    }
    return {
      code: error.code as number,
      ...(error.data === undefined ? {} : { data: (error.data as string).toLowerCase() }),
      kind: 'error',
    };
  }
  throw new QuorumError('malformed_response');
}

export class UpstreamClient {
  constructor(
    private readonly urls: readonly [URL, URL],
    private readonly timeoutMs: number,
    private readonly maximumResponseBytes: number,
    private readonly fetchImplementation: Fetch = fetch
  ) {}

  async request(provider: 0 | 1, method: string, params: unknown[]): Promise<UpstreamOutcome> {
    const id = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.urls[provider], {
        body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        throw new QuorumError('upstream_http_error');
      }
      return decodeResponse(parseStrictJson(await readBounded(response, this.maximumResponseBytes)), id);
    } catch (error) {
      if (error instanceof QuorumError) throw error;
      throw new QuorumError(
        error instanceof DOMException && error.name === 'AbortError' ? 'upstream_timeout' : 'upstream_failure'
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
