import { describe, expect, it } from 'vitest';
import { UpstreamClient } from '../src/upstream';

describe('UpstreamClient', () => {
  it('uses opaque provider-local IDs and decodes a bounded JSON response', async () => {
    const seen: unknown[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ 'accept-encoding': 'identity' });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push(body);
      return new Response(JSON.stringify({ id: body.id, jsonrpc: '2.0', result: '0x6c1' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new UpstreamClient(
      [new URL('https://a.example/secret-a'), new URL('https://b.example/secret-b')],
      1000,
      1024,
      fakeFetch
    );
    await expect(client.request(0, 'eth_chainId', [])).resolves.toEqual({ kind: 'result', result: '0x6c1' });
    expect(seen[0]).toMatchObject({ jsonrpc: '2.0', method: 'eth_chainId', params: [] });
    expect(typeof (seen[0] as Record<string, unknown>).id).toBe('string');
  });

  it('rejects oversized and malformed responses without exposing upstream errors', async () => {
    const oversized: typeof fetch = async () =>
      new Response('x'.repeat(100), { headers: { 'content-length': '100', 'content-type': 'application/json' } });
    const malformed: typeof fetch = async () =>
      new Response('{"jsonrpc":"2.0","id":"wrong","result":"secret-token"}', {
        headers: { 'content-type': 'application/json' },
      });
    const urls: [URL, URL] = [new URL('https://a.example/canary-a'), new URL('https://b.example/canary-b')];
    await expect(new UpstreamClient(urls, 1000, 10, oversized).request(0, 'eth_chainId', [])).rejects.toMatchObject({
      category: 'oversized_response',
      message: 'RPC provider quorum is unavailable',
    });
    await expect(new UpstreamClient(urls, 1000, 1024, malformed).request(0, 'eth_chainId', [])).rejects.not.toThrow(
      /secret-token|canary/
    );

    const chunked: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8));
            controller.enqueue(new Uint8Array(8));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    await expect(new UpstreamClient(urls, 1000, 10, chunked).request(0, 'eth_chainId', [])).rejects.toMatchObject({
      category: 'oversized_response',
    });
  });

  it('enforces the end-to-end upstream timeout and duplicate-key rejection', async () => {
    const timeoutFetch: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('secret-provider-error', 'AbortError')));
      });
    const duplicateFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(`{"id":"${body.id}","jsonrpc":"2.0","result":"0x1","result":"0x2"}`, {
        headers: { 'content-type': 'application/json' },
      });
    };
    const urls: [URL, URL] = [new URL('https://a.example/canary-a'), new URL('https://b.example/canary-b')];
    await expect(new UpstreamClient(urls, 5, 1024, timeoutFetch).request(0, 'eth_chainId', [])).rejects.toMatchObject({
      category: 'upstream_timeout',
    });
    await expect(new UpstreamClient(urls, 1000, 1024, duplicateFetch).request(0, 'eth_chainId', [])).rejects.toMatchObject({
      category: 'upstream_failure',
      message: 'RPC provider quorum is unavailable',
    });
  });
});
