import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoopbackFetch, verifyAbiSelector } from './clients';

const VIRTUAL_ORIGIN = 'https://cannon-api.reya-local.ts.net';
const INGRESS_ORIGIN = 'http://127.0.0.1:8787';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local client transport', () => {
  it('rewrites only an allowed virtual route and preserves query and options', async () => {
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

    await expect(localFetch(`${VIRTUAL_ORIGIN}/rpc/1729?probe=1`, init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, options] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe(`${INGRESS_ORIGIN}/rpc/1729?probe=1`);
    expect(options).toBe(init);
  });

  it.each([
    'https://attacker.example/rpc/1729',
    `${VIRTUAL_ORIGIN}/rpc/1`,
    `${VIRTUAL_ORIGIN}/rpc/1729/suffix`,
    `${VIRTUAL_ORIGIN}/source/reya-deployments/dev/reya-network`,
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
