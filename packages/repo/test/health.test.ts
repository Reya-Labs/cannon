import { describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { bootstrap } from './helpers/bootstrap';
import { getS3Client } from '../src/s3';

describe('GET /health', function () {
  const ctx = bootstrap();

  it('should return 200 when healthy', async function () {
    await ctx.repo.get('/health').expect(200, {
      status: 'ok',
      version,
    });
  });

  it('should return 503 when object storage is unavailable', async function () {
    const healthCheck = vi.spyOn(ctx.s3, 'healthCheck').mockRejectedValueOnce(new Error('S3 unavailable'));

    await ctx.repo.get('/health').expect(503, {
      status: 'error',
      message: 'Repository dependency check failed',
    });

    healthCheck.mockRestore();
  });

  it('should reject an object store that ignores conditional writes', async function () {
    const strictS3 = getS3Client(ctx.config, ctx.config.MEMORY_CACHE);

    try {
      await expect(strictS3.healthCheck()).rejects.toThrow(
        'S3 backend does not enforce atomic If-None-Match conditional writes'
      );
    } finally {
      strictS3.client.destroy();
    }
  });
});
