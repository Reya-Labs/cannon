import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { QuorumService } from '../src/quorum';
import { config } from './fixtures';

function fakeQuorum() {
  return {
    execute: vi.fn().mockResolvedValue({ kind: 'result', result: '0x6c1' }),
    readiness: vi.fn().mockResolvedValue({}),
  } as unknown as QuorumService;
}

function rpc(body: unknown) {
  return request(createApp(config(), fakeQuorum()))
    .post('/rpc/1729')
    .set('Origin', 'https://safe.reya.network')
    .set('x-reya-user', 'alice@example.com')
    .set('x-reya-proxy-secret', 'x'.repeat(32))
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('RPC gateway app', () => {
  it('serves liveness and fail-closed readiness', async () => {
    await request(createApp(config(), fakeQuorum())).get('/livez').expect(200);
    const unavailable = { execute: vi.fn(), readiness: vi.fn().mockRejectedValue(new Error('secret upstream url')) };
    await request(createApp(config(), unavailable as unknown as QuorumService))
      .get('/readyz')
      .expect(503, {
        status: 'unavailable',
        version: 'unknown',
      });
  });

  it('requires exact origin and trusted proxy authentication', async () => {
    const app = createApp(config(), fakeQuorum());
    await request(app)
      .post('/rpc/1729')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(403);
    await request(app)
      .post('/rpc/1729')
      .set('Origin', 'https://evil.example')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(403);
    await request(app)
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(401);
    await request(app)
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'wrong'.repeat(8))
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(401);
  });

  it('returns exact-origin preflight headers', async () => {
    await request(createApp(config(), fakeQuorum()))
      .options('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .expect('Access-Control-Allow-Origin', 'https://safe.reya.network')
      .expect('Access-Control-Allow-Methods', 'POST,OPTIONS')
      .expect(204);
  });

  it('accepts one read-only request and preserves the client ID', async () => {
    await rpc({ id: 7, jsonrpc: '2.0', method: 'eth_chainId', params: [] }).expect(200, {
      id: 7,
      jsonrpc: '2.0',
      result: '0x6c1',
    });
  });

  it('rejects batches, duplicate keys, unsafe methods, compression, query strings, and wrong content types', async () => {
    await rpc([{ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }]).expect(400);
    await request(createApp(config(), fakeQuorum()))
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .set('Content-Type', 'application/json')
      .send('{"id":1,"id":2,"jsonrpc":"2.0","method":"eth_chainId","params":[]}')
      .expect(400);
    await rpc({ id: 1, jsonrpc: '2.0', method: 'eth_sendRawTransaction', params: ['0x00'] }).expect(403);
    await request(createApp(config(), fakeQuorum()))
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .set('Content-Encoding', 'gzip')
      .send('body')
      .expect(415);
    await request(createApp(config(), fakeQuorum()))
      .post('/rpc/1729?url=https://metadata.google.internal')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .set('Content-Type', 'application/json')
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(400);
    await request(createApp(config(), fakeQuorum()))
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .set('Content-Type', 'text/plain')
      .send('{}')
      .expect(415);
  });

  it('does not copy attacker-controlled method text into logs', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await rpc({ id: 1, jsonrpc: '2.0', method: `secret-canary-method-${'x'.repeat(10_000)}`, params: [] }).expect(403);
    expect(warning.mock.calls.flat().join(' ')).not.toContain('secret-canary-method');
    warning.mockRestore();
  });

  it('does not copy provider URLs or credentials from thrown errors into logs', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = {
      execute: vi.fn().mockRejectedValue(new Error('https://provider.example/v3/secret-api-canary')),
      readiness: vi.fn().mockResolvedValue({}),
    };
    await request(createApp(config(), failure as unknown as QuorumService))
      .post('/rpc/1729')
      .set('Origin', 'https://safe.reya.network')
      .set('x-reya-user', 'alice@example.com')
      .set('x-reya-proxy-secret', 'x'.repeat(32))
      .set('Content-Type', 'application/json')
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] })
      .expect(503);
    expect(warning.mock.calls.flat().join(' ')).not.toMatch(/provider\.example|secret-api-canary/);
    warning.mockRestore();
  });

  it('enforces decoded body and weighted method limits', async () => {
    const weighted = config({ limits: { ...config().limits, rateLimit: 4 } });
    const weightedApp = createApp(weighted, fakeQuorum());
    await request(weightedApp)
      .post('/rpc/1729')
      .set('Origin', weighted.uiOrigin)
      .set(weighted.auth.identityHeader, 'alice@example.com')
      .set(weighted.auth.proxySecretHeader, weighted.auth.proxySecret)
      .set('Content-Type', 'application/json')
      .send({ id: 1, jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', true] })
      .expect(429);

    const small = config({ limits: { ...config().limits, bodyBytes: 64 } });
    await request(createApp(small, fakeQuorum()))
      .post('/rpc/1729')
      .set('Origin', small.uiOrigin)
      .set(small.auth.identityHeader, 'alice@example.com')
      .set(small.auth.proxySecretHeader, small.auth.proxySecret)
      .set('Content-Type', 'application/json')
      .send({ id: 2, jsonrpc: '2.0', method: 'eth_call', params: [{ data: `0x${'11'.repeat(64)}` }, 'latest'] })
      .expect(413);
  });

  it('does not burn global capacity for requests rejected by an exhausted actor budget', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bounded = config({
      limits: { ...config().limits, rateLimit: 5 },
      trustProxy: 1,
    });
    const app = createApp(bounded, fakeQuorum());
    const fullBlock = (actor: string, ip: string, id: number) =>
      request(app)
        .post('/rpc/1729')
        .set('Origin', bounded.uiOrigin)
        .set(bounded.auth.identityHeader, actor)
        .set(bounded.auth.proxySecretHeader, bounded.auth.proxySecret)
        .set('X-Forwarded-For', ip)
        .set('Content-Type', 'application/json')
        .send({ id, jsonrpc: '2.0', method: 'eth_getBlockByNumber', params: ['latest', true] });

    await fullBlock('attacker', '192.0.2.1', 1).expect(200);
    for (let attempt = 0; attempt < 4; attempt++) {
      await fullBlock('attacker', '192.0.2.1', 2 + attempt).expect(429);
    }
    for (let actor = 0; actor < 19; actor++) {
      await fullBlock(`legitimate-${actor}`, `198.51.100.${actor + 1}`, 100 + actor).expect(200);
    }
    info.mockRestore();
    warning.mockRestore();
  });
});
