import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';

const validEnvironment = {
  NODE_ENV: 'production',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'https://objects.example.com',
  S3_BUCKET: 'cannon',
  S3_FOLDER: 'repo-v2',
  S3_REGION: 'us-east-1',
  S3_READ_KEY: 'read-key',
  S3_READ_SECRET: 'read-secret',
  S3_WRITE_KEY: 'write-key',
  S3_WRITE_SECRET: 'write-secret',
  API_TOKEN_SECRET: 'token-secret',
};

describe('repository configuration', function () {
  function expectConfigurationFailure(environment: Record<string, string>) {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`environment validation exited with ${code}`);
    });

    try {
      expect(() => loadConfig(environment)).toThrow('environment validation exited with 1');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  }

  it('accepts distinct read and write object-storage credentials', function () {
    const config = loadConfig(validEnvironment);

    expect(config.S3_READ_KEY).toBe('read-key');
    expect(config.S3_WRITE_KEY).toBe('write-key');
  });

  it.each(['S3_READ_KEY', 'S3_READ_SECRET', 'S3_WRITE_KEY', 'S3_WRITE_SECRET'])(
    'fails closed when %s is missing',
    function (missingField) {
      const environment: Record<string, string> = { ...validEnvironment };
      delete environment[missingField];

      expectConfigurationFailure(environment);
    }
  );

  it('does not fall back to the legacy shared credential fields', function () {
    const environment: Record<string, string> = {
      ...validEnvironment,
      S3_KEY: 'legacy-key',
      S3_SECRET: 'legacy-secret',
    };

    for (const field of ['S3_READ_KEY', 'S3_READ_SECRET', 'S3_WRITE_KEY', 'S3_WRITE_SECRET']) {
      delete environment[field];
    }

    expectConfigurationFailure(environment);
  });

  it('rejects empty credential values', function () {
    expectConfigurationFailure({
      ...validEnvironment,
      S3_READ_KEY: '',
    });
  });
});
