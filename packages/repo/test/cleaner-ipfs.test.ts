import { afterEach, describe, expect, it, vi } from 'vitest';
import { compress } from '@usecannon/artifact-codec';
import { deleteLegacyIpfsPin, readLegacyIpfsArtifact } from '../src/cleaner';

const CID = 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('legacy IPFS cleaner requests', () => {
  it('reads and decodes an artifact through the Kubo cat endpoint', async () => {
    const artifact = { miscUrl: `ipfs://${CID}`, cannon: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from(compress(JSON.stringify(artifact))), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readLegacyIpfsArtifact('https+ipfs://repo.example', CID, 1_000)).resolves.toEqual(artifact);
    expect(fetchMock).toHaveBeenCalledWith(new URL(`https://repo.example/api/v0/cat?arg=${CID}`), {
      method: 'POST',
      signal: expect.any(AbortSignal),
    });
  });

  it('removes an artifact through the Kubo pin endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteLegacyIpfsPin('https+ipfs://repo.example', CID, 1_000)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(new URL(`https://repo.example/api/v0/pin/rm?arg=${CID}`), {
      method: 'POST',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ['read', () => readLegacyIpfsArtifact('https://repo.example', CID, 1_000)],
    ['remove', () => deleteLegacyIpfsPin('https://repo.example', CID, 1_000)],
  ])('fails closed when the %s endpoint returns a non-success status', async (_, request) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(request()).rejects.toThrow(`"${CID}" from the legacy IPFS endpoint: HTTP 503`);
  });

  it('aborts a stalled legacy cat request at the configured timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: URL, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          })
      )
    );

    await expect(readLegacyIpfsArtifact('https://repo.example', CID, 5)).rejects.toThrow(
      `failed to read "${CID}" from the legacy IPFS endpoint: The operation was aborted due to timeout`
    );
  });

  it('rejects malformed compressed artifact bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-compressed-json', { status: 200 })));

    await expect(readLegacyIpfsArtifact('https://repo.example', CID, 1_000)).rejects.toThrow(
      `failed to decode "${CID}" from the legacy IPFS endpoint`
    );
  });
});
