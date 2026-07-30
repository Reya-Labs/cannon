import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackFetch, createReyaLocalClients, verifyAbiSelector } from './clients';

const VIRTUAL_ORIGIN = 'https://cannon-api.reya-local.ts.net';
const INGRESS_ORIGIN = 'http://127.0.0.1:8787';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local client transport', () => {
  it('rewrites only an exact artifact route and preserves query and options', async () => {
    const response = new Response('{}', { status: 200 });
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const localFetch = createLoopbackFetch(INGRESS_ORIGIN);
    const init: NonNullable<Parameters<typeof fetch>[1]> = {
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    };

    const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
    await expect(localFetch(`${VIRTUAL_ORIGIN}/artifacts/api/v0/cat?arg=${cid}`, init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, options] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(`${INGRESS_ORIGIN}/artifacts/api/v0/cat?arg=${cid}`);
    expect(options).toBe(init);
  });

  it('generates one canonical preview request through the fixed ingress route', async () => {
    const encoded = '{"schemaVersion":3}';
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(encoded, {
        headers: {
          'content-length': String(encoded.length),
          'content-type': 'application/json',
        },
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const safeAddress = '0x1111111111111111111111111111111111111111' as const;
    const partialDeployCid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const previousPackageCid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
    const clients = createReyaLocalClients({
      chainId: 1729,
      ingressOrigin: INGRESS_ORIGIN,
      safeAddress,
      sourceCommit: commit,
      stagingEnabled: false,
    });

    await expect(
      clients.preview.generate({
        commit,
        partialDeployCid,
        previousPackageCid,
      })
    ).resolves.toBe(encoded);
    const [target, options] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(`${INGRESS_ORIGIN}/preview/1729`);
    expect(options?.method).toBe('POST');
    expect(options?.body).toBe(
      JSON.stringify({
        chainId: 1729,
        commit,
        partialDeployCid,
        previousPackageCid,
        safeAddress,
      })
    );
  });

  it('exposes only the configured Safe staging route when activation is explicit', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('[]', {
          headers: {
            'content-length': '2',
            'content-type': 'application/json',
          },
          status: 200,
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const safeAddress = '0x1111111111111111111111111111111111111111' as const;
    const clients = createReyaLocalClients({
      chainId: 1729,
      ingressOrigin: INGRESS_ORIGIN,
      safeAddress,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      stagingEnabled: true,
    });

    await expect(clients.activation?.staging.current()).resolves.toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${INGRESS_ORIGIN}/staging/1729/${safeAddress}`);
    await expect(
      createLoopbackFetch(INGRESS_ORIGIN, {
        safeAddress,
        stagingEnabled: true,
      })(`${VIRTUAL_ORIGIN}/staging/1729/0x2222222222222222222222222222222222222222`)
    ).rejects.toThrow('route is not allowed');
  });

  it.each([
    'https://attacker.example/rpc/1729',
    `${VIRTUAL_ORIGIN}/rpc/1`,
    `${VIRTUAL_ORIGIN}/rpc/1729?probe=1`,
    `${VIRTUAL_ORIGIN}/rpc/1729/suffix`,
    `${VIRTUAL_ORIGIN}/artifacts/api/v0/cat`,
    `${VIRTUAL_ORIGIN}/artifacts/api/v0/cat?arg=not-a-cid`,
    `${VIRTUAL_ORIGIN}/artifacts/api/v0/cat?arg=QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn&arg=QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn`,
    `${VIRTUAL_ORIGIN}/source/reya-deployments/dev/reya-network`,
    `${VIRTUAL_ORIGIN}/staging/1729/0x1111111111111111111111111111111111111111`,
    `${VIRTUAL_ORIGIN}/staging/1729/0x1111111111111111111111111111111111111111/suffix`,
  ])('rejects an undeclared route: %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(createLoopbackFetch(INGRESS_ORIGIN)(url)).rejects.toThrow('Reya local client route is not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ABI selector verification', () => {
  it('accepts the exact selector without depending on case', () => {
    expect(verifyAbiSelector('transfer(address,uint256)', '0xa9059cbb')).toBe(true);
    expect(verifyAbiSelector('transfer(address,uint256)', '0xA9059CBB')).toBe(true);
  });

  it('rejects mismatches and malformed inputs', () => {
    expect(verifyAbiSelector('transfer(address,uint256)', '0xdeadbeef')).toBe(false);
    expect(verifyAbiSelector('not a signature', '0xdeadbeef')).toBe(false);
    expect(verifyAbiSelector(undefined as unknown as string, '0xa9059cbb')).toBe(false);
  });
});
