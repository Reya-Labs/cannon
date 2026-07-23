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
    const putObject = vi.spyOn(strictS3.client, 'putObject');
    const transientError = new Error('transient S3 failure');

    try {
      putObject
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError);

      await expect(strictS3.healthCheck()).rejects.toThrow('transient S3 failure');
      const transientProbeKey = putObject.mock.calls[0][0].Key;
      const transientValidationCalls = putObject.mock.calls.length;

      await expect(strictS3.healthCheck()).rejects.toThrow(
        'S3 backend does not enforce atomic If-None-Match conditional writes'
      );
      const unsupportedValidationCalls = putObject.mock.calls.length;
      const unsupportedProbeKey = putObject.mock.calls[transientValidationCalls][0].Key;

      expect(unsupportedValidationCalls).toBeGreaterThan(transientValidationCalls);
      expect(unsupportedProbeKey).not.toEqual(transientProbeKey);

      await expect(strictS3.healthCheck()).rejects.toThrow(
        'S3 backend does not enforce atomic If-None-Match conditional writes'
      );
      expect(putObject.mock.calls.length).toEqual(unsupportedValidationCalls);
    } finally {
      strictS3.client.destroy();
    }
  });
});
