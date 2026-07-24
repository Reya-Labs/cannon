import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const validS3Environment = {
  NODE_ENV: 'production',
  REPO_ROLE: 'combined',
  OBJECT_STORE_PROVIDER: 's3',
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
  CORS_ALLOWED_ORIGINS: '',
};

describe('repository configuration', function () {
  it('accepts distinct read and write object-storage credentials', function () {
    const config = loadConfig(validS3Environment);

    expect(config.S3_READ_KEY).toBe('read-key');
    expect(config.S3_WRITE_KEY).toBe('write-key');
  });

  it.each(['S3_READ_KEY', 'S3_READ_SECRET', 'S3_WRITE_KEY', 'S3_WRITE_SECRET'])(
    'fails closed when %s is missing',
    function (missingField) {
      const environment: Record<string, string> = { ...validS3Environment };
      delete environment[missingField];

      expect(() => loadConfig(environment)).toThrow(`${missingField} must not be empty`);
    }
  );

  it('does not fall back to the legacy shared credential fields', function () {
    const environment: Record<string, string> = {
      ...validS3Environment,
      S3_KEY: 'legacy-key',
      S3_SECRET: 'legacy-secret',
    };

    for (const field of ['S3_READ_KEY', 'S3_READ_SECRET', 'S3_WRITE_KEY', 'S3_WRITE_SECRET']) {
      delete environment[field];
    }

    expect(() => loadConfig(environment)).toThrow('S3_READ_KEY must not be empty');
  });

  it('rejects empty credential values', function () {
    expect(() =>
      loadConfig({
        ...validS3Environment,
        S3_READ_KEY: '',
      })
    ).toThrow('S3_READ_KEY must not be empty');
  });

  it.each(['production', 'staging'])('rejects a shared read/write identity in %s', function (nodeEnvironment) {
    expect(() =>
      loadConfig({
        ...validS3Environment,
        NODE_ENV: nodeEnvironment,
        S3_WRITE_KEY: validS3Environment.S3_READ_KEY,
      })
    ).toThrow('S3_READ_KEY and S3_WRITE_KEY must identify different object-storage credentials');
  });

  it('accepts a GCS reader without Redis, API credentials, or S3 credentials', function () {
    const config = loadConfig({
      NODE_ENV: 'production',
      REPO_ROLE: 'reader',
      OBJECT_STORE_PROVIDER: 'gcs',
      GCS_PROJECT_ID: 'reya-mainnet',
      GCS_BUCKET: 'reya-cannon-artifacts',
      GCS_FOLDER: 'repo-v2',
    });

    expect(config.REPO_ROLE).toBe('reader');
    expect(config.REDIS_URL).toBe('');
    expect(config.API_TOKEN_SECRET).toBe('');
  });

  it('accepts a GCS writer with Redis and an API token', function () {
    const config = loadConfig({
      NODE_ENV: 'production',
      REPO_ROLE: 'writer',
      OBJECT_STORE_PROVIDER: 'gcs',
      REDIS_URL: 'redis://localhost:6379',
      API_TOKEN_SECRET: 'token-secret',
      GCS_BUCKET: 'reya-cannon-artifacts',
      GCS_FOLDER: 'repo-v2',
    });

    expect(config.REPO_ROLE).toBe('writer');
  });

  it('accepts an exact HTTPS CORS allowlist', function () {
    const config = loadConfig({
      ...validS3Environment,
      CORS_ALLOWED_ORIGINS: 'https://cannon.example.com, https://staging-cannon.example.com',
    });

    expect(config.CORS_ALLOWED_ORIGINS).toContain('https://cannon.example.com');
  });

  it.each(['*', 'https://cannon.example.com/path', 'http://cannon.example.com'])(
    'rejects unsafe production CORS origin %s',
    function (origin) {
      expect(() =>
        loadConfig({
          ...validS3Environment,
          CORS_ALLOWED_ORIGINS: origin,
        })
      ).toThrow('CORS_ALLOWED_ORIGINS');
    }
  );

  it.each(['production', 'staging'])('requires separate GCS roles in %s', function (nodeEnvironment) {
    expect(() =>
      loadConfig({
        NODE_ENV: nodeEnvironment,
        REPO_ROLE: 'combined',
        OBJECT_STORE_PROVIDER: 'gcs',
        REDIS_URL: 'redis://localhost:6379',
        API_TOKEN_SECRET: 'token-secret',
        GCS_BUCKET: 'reya-cannon-artifacts',
        GCS_FOLDER: 'repo-v2',
      })
    ).toThrow('GCS production and staging workloads must use separate reader or writer roles');
  });

  it('requires a GCS bucket', function () {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REPO_ROLE: 'reader',
        OBJECT_STORE_PROVIDER: 'gcs',
        GCS_BUCKET: '',
        GCS_FOLDER: 'repo-v2',
      })
    ).toThrow('GCS_BUCKET must not be empty');
  });

  it('requires Redis for the writer role', function () {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REPO_ROLE: 'writer',
        OBJECT_STORE_PROVIDER: 'gcs',
        REDIS_URL: '',
        API_TOKEN_SECRET: 'token-secret',
        GCS_BUCKET: 'reya-cannon-artifacts',
        GCS_FOLDER: 'repo-v2',
      })
    ).toThrow('REDIS_URL must not be empty');
  });

  it('requires an API token secret for the writer role', function () {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        REPO_ROLE: 'writer',
        OBJECT_STORE_PROVIDER: 'gcs',
        REDIS_URL: 'redis://localhost:6379',
        API_TOKEN_SECRET: '',
        GCS_BUCKET: 'reya-cannon-artifacts',
        GCS_FOLDER: 'repo-v2',
      })
    ).toThrow('API_TOKEN_SECRET must not be empty');
  });

  it('allows role-specific S3 credentials', function () {
    const reader = loadConfig({
      ...validS3Environment,
      REPO_ROLE: 'reader',
      REDIS_URL: '',
      API_TOKEN_SECRET: '',
      S3_WRITE_KEY: '',
      S3_WRITE_SECRET: '',
    });
    const writer = loadConfig({
      ...validS3Environment,
      REPO_ROLE: 'writer',
      S3_READ_KEY: '',
      S3_READ_SECRET: '',
    });

    expect(reader.REPO_ROLE).toBe('reader');
    expect(writer.REPO_ROLE).toBe('writer');
  });
});
