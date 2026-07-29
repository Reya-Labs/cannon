import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createReyaReadOnlyClients,
  REYA_READ_LIMITS,
  ReyaReadClientError,
  SOURCE_REPOSITORY,
  SOURCE_ROOT,
  SOURCE_ROUTE_PREFIX,
} from '../src/clients/index.mjs';
import {
  clientWith,
  jsonResponse,
  SERVICE_ORIGIN,
} from '../test-support/client-fixtures.mjs';

const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bundle(overrides = {}) {
  const files = [
    {
      content: 'include = ["utils/constants.toml"]\n',
      path: SOURCE_ROOT,
      sha256: digest('include = ["utils/constants.toml"]\n'),
    },
    {
      content: '[var]\nvalue = "1"\n',
      path: 'packages/tomls/src/omnibus/utils/constants.toml',
      sha256: digest('[var]\nvalue = "1"\n'),
    },
  ];
  const canonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: COMMIT,
    root: SOURCE_ROOT,
    files,
  };
  return {
    ...canonical,
    bundleSha256: digest(JSON.stringify(canonical)),
    ...overrides,
  };
}

function bundleFromFiles(files) {
  const canonicalFiles = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({ content, path, sha256: digest(content) }));
  const canonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: COMMIT,
    root: SOURCE_ROOT,
    files: canonicalFiles,
  };
  return {
    ...canonical,
    bundleSha256: digest(JSON.stringify(canonical)),
  };
}

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('loads one exact immutable Reya source bundle without Git credentials', async () => {
  let request;
  const client = clientWith(async (url, options) => {
    request = { options, url };
    return jsonResponse(bundle());
  });

  const result = await client.source.bundle({ commit: COMMIT });

  assert.equal(result.commit, COMMIT);
  assert.equal(result.repository, SOURCE_REPOSITORY);
  assert.equal(result.root, SOURCE_ROOT);
  assert.equal(result.files.length, 2);
  assert.deepEqual(
    result.orderedFiles.map(({ path }) => path),
    [SOURCE_ROOT, 'packages/tomls/src/omnibus/utils/constants.toml']
  );
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.files));
  assert.ok(Object.isFrozen(result.orderedFiles));
  assert.ok(Object.isFrozen(result.files[0]));
  assert.equal(
    request.url,
    `${SERVICE_ORIGIN}${SOURCE_ROUTE_PREFIX}${COMMIT}/reya-network`
  );
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal('Authorization' in request.options.headers, false);
  assert.equal('body' in request.options, false);
});

for (const input of [
  { commit: 'main' },
  { commit: COMMIT.toUpperCase() },
  { commit: `${COMMIT}/other` },
  { commit: COMMIT, repository: 'other/repository' },
  null,
]) {
  test(`rejects malformed or mutable source input ${JSON.stringify(
    input
  )}`, async () => {
    const client = clientWith(async () => {
      throw new Error('invalid input must not reach fetch');
    });
    await assert.rejects(
      () => client.source.bundle(input),
      assertClientError('INVALID_INPUT')
    );
  });
}

test('rejects tampered, unsorted, unbounded, and wrong-source bundles', async () => {
  const cases = [
    bundle({ commit: '3b10669075b91eb8db781d199292f30c52f8e994' }),
    bundle({ repository: 'Other/reya-deployments' }),
    bundle({ root: 'packages/tomls/src/other.toml' }),
    bundle({ bundleSha256: '0'.repeat(64) }),
    (() => {
      const value = bundle();
      value.files[0].content = 'tampered = true\n';
      return value;
    })(),
    (() => {
      const value = bundle();
      value.files.reverse();
      return value;
    })(),
    (() => {
      const value = bundle();
      value.files[0].extra = 'field';
      return value;
    })(),
    (() => {
      const value = bundle();
      value.files = Array.from({ length: 513 }, (_, index) => ({
        content: '',
        path: `packages/tomls/src/${String(index).padStart(3, '0')}.toml`,
        sha256: digest(''),
      }));
      return value;
    })(),
  ];

  for (const value of cases) {
    const client = clientWith(async () => jsonResponse(value));
    await assert.rejects(
      () => client.source.bundle({ commit: COMMIT }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('enforces declared and streamed source response limits', async () => {
  const client = clientWith(
    async () =>
      new Response(new Uint8Array([1]), {
        headers: {
          'content-length': String(REYA_READ_LIMITS.sourceBytes + 1),
          'content-type': 'application/json',
        },
      })
  );
  await assert.rejects(
    () => client.source.bundle({ commit: COMMIT }),
    assertClientError('RESPONSE_REJECTED')
  );
});

test('allows an independently bounded source deadline', () => {
  assert.doesNotThrow(() =>
    createReyaReadOnlyClients({
      deadlines: {
        artifactDeadlineMs: 1,
        queryDeadlineMs: 1,
        sourceDeadlineMs: 1,
      },
      fetchImpl: async () => {
        throw new Error('unused');
      },
      serviceOrigin: SERVICE_ORIGIN,
      verifyAbiSelector: async () => true,
      verifyArtifactCid: async () => '',
    })
  );
});

test('uses its pinned TOML parser and rejects missing or extra include files', async () => {
  const missing = bundle();
  missing.files = missing.files.slice(0, 1);
  const missingCanonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: COMMIT,
    root: SOURCE_ROOT,
    files: missing.files,
  };
  missing.bundleSha256 = digest(JSON.stringify(missingCanonical));

  const extra = bundle();
  extra.files.push({
    content: 'unused = true\n',
    path: 'packages/tomls/src/zz_unused.toml',
    sha256: digest('unused = true\n'),
  });
  const extraCanonical = {
    schemaVersion: 1,
    repository: SOURCE_REPOSITORY,
    commit: COMMIT,
    root: SOURCE_ROOT,
    files: extra.files,
  };
  extra.bundleSha256 = digest(JSON.stringify(extraCanonical));

  for (const value of [missing, extra]) {
    const client = clientWith(async () => jsonResponse(value));
    await assert.rejects(
      () => client.source.bundle({ commit: COMMIT }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('accepts a shared file reached shallowly before a deeper diamond edge', async () => {
  const shared = 'packages/tomls/src/omnibus/shared.toml';
  const files = new Map([
    [SOURCE_ROOT, 'include = ["shared.toml", "chain/00.toml"]\n'],
    [shared, 'version = "1"\n'],
  ]);
  for (let index = 0; index < 16; index += 1) {
    const name = String(index).padStart(2, '0');
    const next =
      index === 15 ? '../shared.toml' : `${String(index + 1).padStart(2, '0')}.toml`;
    files.set(
      `packages/tomls/src/omnibus/chain/${name}.toml`,
      `include = ["${next}"]\n`
    );
  }
  const client = clientWith(async () => jsonResponse(bundleFromFiles(files)));

  const result = await client.source.bundle({ commit: COMMIT });

  assert.equal(result.files.length, 18);
  assert.equal(result.orderedFiles[1].path, shared);
});
