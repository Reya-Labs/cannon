import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { QuorumService } from '../src/quorum';
import { UpstreamClient } from '../src/upstream';
import { config, encodedOwners, encodedUint } from './fixtures';

const servers: Server[] = [];

async function provider(disagreeBalance = false): Promise<URL> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id: string; method: string; params: unknown[] };
      let result: unknown;
      if (rpc.method === 'eth_chainId') result = '0x6c1';
      else if (rpc.method === 'eth_blockNumber') result = '0x64';
      else if (rpc.method === 'eth_getBlockByNumber') {
        result = {
          hash: `0x${'12'.repeat(32)}`,
          number: rpc.params[0],
          parentHash: `0x${'34'.repeat(32)}`,
          stateRoot: `0x${'56'.repeat(32)}`,
          timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          transactions: [],
        };
      } else if (rpc.method === 'eth_getCode') result = '0x6001';
      else if (rpc.method === 'eth_call') {
        const call = rpc.params[0] as { data: string };
        if (call.data === '0xaffed0e0') result = encodedUint(7n);
        else if (call.data === '0xa0e67e2b') result = encodedOwners();
        else if (call.data === '0xe75235b8') result = encodedUint(1n);
        else result = '0x1234';
      } else if (rpc.method === 'eth_getBalance') result = disagreeBalance ? '0x11' : '0x10';
      else result = null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: '2.0', result }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('test provider did not bind TCP');
  return new URL(`http://127.0.0.1:${address.port}`);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe('local two-provider integration', () => {
  it('serves a browser read only after both local providers agree', async () => {
    const upstreams = (await Promise.all([provider(), provider()])) as [URL, URL];
    const localConfig = config({ upstreams });
    const quorum = new QuorumService(
      localConfig,
      new UpstreamClient(upstreams, localConfig.quorum.timeoutMs, localConfig.limits.responseBytes)
    );
    const response = await request(createApp(localConfig, quorum))
      .post('/rpc/1729')
      .set('Origin', localConfig.uiOrigin)
      .set(localConfig.auth.identityHeader, 'alice@example.com')
      .set(localConfig.auth.proxySecretHeader, localConfig.auth.proxySecret)
      .set('Content-Type', 'application/json')
      .send({
        id: 9,
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: ['0x1111111111111111111111111111111111111111', 'latest'],
      })
      .expect(200);
    expect(response.body).toEqual({ id: 9, jsonrpc: '2.0', result: '0x10' });
  });

  it('returns a sanitized 503 when local providers disagree', async () => {
    const upstreams = (await Promise.all([provider(), provider(true)])) as [URL, URL];
    const localConfig = config({ upstreams });
    const quorum = new QuorumService(
      localConfig,
      new UpstreamClient(upstreams, localConfig.quorum.timeoutMs, localConfig.limits.responseBytes)
    );
    const response = await request(createApp(localConfig, quorum))
      .post('/rpc/1729')
      .set('Origin', localConfig.uiOrigin)
      .set(localConfig.auth.identityHeader, 'alice@example.com')
      .set(localConfig.auth.proxySecretHeader, localConfig.auth.proxySecret)
      .set('Content-Type', 'application/json')
      .send({
        id: 10,
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: ['0x1111111111111111111111111111111111111111', 'latest'],
      })
      .expect(503);
    expect(response.body).toEqual({
      error: { code: 'rpc_quorum_unavailable', message: 'RPC provider quorum is temporarily unavailable' },
    });
  });
});
