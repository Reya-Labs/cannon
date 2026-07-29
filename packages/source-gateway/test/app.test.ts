import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { SourceBundleService } from '../src/source';
import { archive, archiveResponse, COMMIT, ROOT_TOML } from './fixtures';

const config: AppConfig = {
  auth: {
    identityHeader: 'x-reya-user',
    proxySecret: '0123456789abcdef0123456789abcdef',
    proxySecretHeader: 'x-reya-proxy-secret',
  },
  port: 8080,
  rateLimit: { limit: 60, windowMs: 60_000 },
  trustProxy: false,
  uiOrigin: 'https://cannon.example.ts.net',
};

function authorized(input: request.Test): request.Test {
  return input
    .set('Origin', config.uiOrigin)
    .set(config.auth.identityHeader, 'owner@example.com')
    .set(config.auth.proxySecretHeader, config.auth.proxySecret);
}

describe('source gateway HTTP boundary', () => {
  it('serves a deterministic immutable bundle and coalesces exact-SHA fetches', async () => {
    const bytes = await archive(COMMIT, [{ body: 'version = "1"\n', name: ROOT_TOML }]);
    const fetchImpl = vi.fn(async () => archiveResponse(bytes));
    const app = createApp(config, new SourceBundleService(fetchImpl as typeof fetch));
    const route = `/source/reya-deployments/${COMMIT}/reya-network`;

    const [first, second] = await Promise.all([authorized(request(app).get(route)), authorized(request(app).get(route))]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect(first.body.commit).toBe(COMMIT);
    expect(first.body.files.map((file: { path: string }) => file.path)).toEqual([
      'packages/tomls/src/omnibus/reya_network.toml',
    ]);
    expect(first.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(first.headers.etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(first.headers['access-control-allow-origin']).toBe(config.uiOrigin);
    expect(fetchImpl).toHaveBeenCalledOnce();

    const cached = await authorized(request(app).get(route)).set('If-None-Match', first.headers.etag);
    expect(cached.status).toBe(304);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'missing proxy secret',
      (call: request.Test) => call.set('Origin', config.uiOrigin).set(config.auth.identityHeader, 'owner@example.com'),
      401,
    ],
    [
      'wrong proxy secret',
      (call: request.Test) =>
        call
          .set('Origin', config.uiOrigin)
          .set(config.auth.identityHeader, 'owner@example.com')
          .set(config.auth.proxySecretHeader, 'x'.repeat(32)),
      401,
    ],
    [
      'missing identity',
      (call: request.Test) =>
        call.set('Origin', config.uiOrigin).set(config.auth.proxySecretHeader, config.auth.proxySecret),
      401,
    ],
    [
      'missing origin with ambient identity',
      (call: request.Test) =>
        call
          .set(config.auth.identityHeader, 'owner@example.com')
          .set(config.auth.proxySecretHeader, config.auth.proxySecret),
      403,
    ],
    ['moving ref', (call: request.Test) => authorized(call), 400, '/source/reya-deployments/main/reya-network'],
    [
      'query string',
      (call: request.Test) => authorized(call),
      400,
      `/source/reya-deployments/${COMMIT}/reya-network?repo=other`,
    ],
    [
      'wrong origin',
      (call: request.Test) =>
        call
          .set('Origin', 'https://evil.example')
          .set(config.auth.identityHeader, 'owner@example.com')
          .set(config.auth.proxySecretHeader, config.auth.proxySecret),
      403,
    ],
  ] as const)('rejects %s', async (_name, decorate, status, path = `/source/reya-deployments/${COMMIT}/reya-network`) => {
    const app = createApp(
      config,
      new SourceBundleService(async () => {
        throw new Error('rejected request must not reach upstream');
      })
    );
    const response = await decorate(request(app).get(path));
    expect(response.status).toBe(status);
  });

  it('keeps health checks origin-free but requires the exact origin for preflight', async () => {
    const app = createApp(config, new SourceBundleService());
    expect((await request(app).get('/readyz')).status).toBe(200);
    expect(
      (await request(app).options(`/source/reya-deployments/${COMMIT}/reya-network`).set('Origin', config.uiOrigin)).status
    ).toBe(204);
    expect((await request(app).options(`/source/reya-deployments/${COMMIT}/reya-network`)).status).toBe(403);
  });

  it('does not expose upstream failure details', async () => {
    const app = createApp(
      config,
      new SourceBundleService(async () => {
        throw new Error('secret upstream credential');
      })
    );
    const response = await authorized(request(app).get(`/source/reya-deployments/${COMMIT}/reya-network`));
    expect(response.status).toBe(502);
    expect(response.text).not.toContain('secret');
    expect(response.body.error.code).toBe('source_upstream_failed');
  });
});
