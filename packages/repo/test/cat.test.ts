import { describe, expect, it, vi } from 'vitest';
import { uncompress } from '../../builder/src/ipfs';
import { bootstrap } from './helpers/bootstrap';
import { loadFixture } from './helpers/fixtures';

describe('HEAD /api/v0/cat', function () {
  const ctx = bootstrap();

  it('should return 400 on missing ipfshash', async function () {
    await ctx.repo.head('/api/v0/cat').expect(400);
  });

  it('should return 404 on unregistered ipfshash', async function () {
    const { cid } = await loadFixture('registry');
    await ctx.repo.head(`/api/v0/cat?arg=${cid}`).expect(404);
  });

  it('should 200 when a file is available on S3', async function () {
    const { cid, data } = await loadFixture('registry');
    await ctx.s3Write.putObject(cid, data);
    await ctx.repo.head(`/api/v0/cat?arg=${cid}`).expect(200);
  });
});

describe('POST /api/v0/cat', function () {
  const ctx = bootstrap();

  it('should return 400 on missing ipfshash', async function () {
    await ctx.repo.post('/api/v0/cat').expect(400, 'argument "ipfs-path" is required');
  });

  it('should return 404 on unregistered ipfshash', async function () {
    const { cid } = await loadFixture('owned-greeter');
    await ctx.repo.post(`/api/v0/cat?arg=${cid}`).expect(404, 'unregistered ipfs data');
  });

  it('should return a file that is available on S3', async function () {
    const { cid, data, content } = await loadFixture('registry');

    await ctx.s3Write.putObject(cid, data);

    const res = await ctx.repo
      .post(`/api/v0/cat?arg=${cid}`)
      .set('Accept', 'application/octet-stream')
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    const result = JSON.parse(uncompress(res.body));
    expect(result).toEqual(content);
  });

  it('should reject a stored object whose bytes do not match its CID', async function () {
    const { cid } = await loadFixture('registry');
    await ctx.s3Write.putObject(cid, Buffer.from('corrupt'));
    await ctx.repo.post(`/api/v0/cat?arg=${cid}`).expect(502, 'stored artifact integrity check failed');
  });

  it('should not fetch a missing artifact from an upstream IPFS service', async function () {
    const { cid } = await loadFixture('registry');
    await ctx.repo.post(`/api/v0/cat?arg=${cid}`).expect(404, 'unregistered ipfs data');
    expect(await ctx.s3Read.objectExists(cid)).toBe(false);
  });

  it('should never use the write-capable client for reads', async function () {
    const { cid, data } = await loadFixture('registry');
    await ctx.s3Write.putObject(cid, data);

    const writeExists = vi
      .spyOn(ctx.s3Write, 'objectExists')
      .mockRejectedValue(new Error('write-capable client used by read'));
    const writeObject = vi.spyOn(ctx.s3Write, 'getObject').mockRejectedValue(new Error('write-capable client used by read'));

    try {
      await ctx.repo.post(`/api/v0/cat?arg=${cid}`).expect(200);
    } finally {
      writeExists.mockRestore();
      writeObject.mockRestore();
    }
  });
});
