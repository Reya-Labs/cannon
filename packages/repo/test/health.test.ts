import { describe, it, vi } from 'vitest';
import { version } from '../package.json';
import { bootstrap } from './helpers/bootstrap';

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
});
