import { describe, expect, it } from 'vitest';
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
    await ctx.s3.putObject(cid, data);
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

    await ctx.s3.putObject(cid, data);

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
    await ctx.s3.putObject(cid, Buffer.from('corrupt'));
    await ctx.repo.post(`/api/v0/cat?arg=${cid}`).expect(502, 'stored artifact integrity check failed');
  });

  it('should reject fallback bytes that do not match the requested CID', async function () {
    const requested = await loadFixture('registry');
    const wrong = await loadFixture('owned-greeter');
    ctx.ipfsMock.set(requested.cid, wrong.data);

    await ctx.repo.post(`/api/v0/cat?arg=${requested.cid}`).expect(502, 'upstream artifact integrity check failed');

    expect(await ctx.s3.objectExists(requested.cid)).toBe(false);
  });

  it('should reject an oversized fallback artifact with 413', async function () {
    const requested = await loadFixture('registry');
    ctx.ipfsMock.set(requested.cid, Buffer.alloc(1024 * 1024 + 1));

    await ctx.repo.post(`/api/v0/cat?arg=${requested.cid}`).expect(413, 'upstream artifact too large');

    expect(await ctx.s3.objectExists(requested.cid)).toBe(false);
  });

  it('should return a pinned file that is not registered but it is available on ipfs', async function () {
    const { cid, data, content } = await loadFixture('registry');

    await ctx.ipfsMock.add(data);

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

    expect(Buffer.from(await ctx.s3.getObject(cid))).toEqual(data);
    await ctx.ipfsMock.remove(cid);

    const backfilled = await ctx.repo
      .post(`/api/v0/cat?arg=${cid}`)
      .set('Accept', 'application/octet-stream')
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(backfilled.body).toEqual(data);
  });
});
