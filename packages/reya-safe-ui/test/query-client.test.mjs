import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
  QUERY_ROUTE_PATHS,
  REYA_READ_LIMITS,
  ReyaReadClientError,
} from '../src/clients/index.mjs';
import {
  ABI_SIGNATURE_CONFORMANCE_VECTORS,
  isCanonicalAbiSignature,
} from '../src/clients/schema.mjs';
import {
  clientWith,
  DEPLOY_CID,
  jsonResponse,
  packageDocument,
  searchResponse,
  SERVICE_ORIGIN,
  streamResponse,
} from '../test-support/client-fixtures.mjs';

const SELECTOR = '0x8da5cb5b';

function selectorDocument(overrides = {}) {
  return {
    address: '0x0000000000000000000000000000000000000001',
    chainId: 1729,
    contractName: 'CoreProxy',
    name: 'owner()',
    packageName: 'reya-omnibus',
    preset: 'main',
    selector: SELECTOR,
    type: 'function',
    version: '1.2.3',
    ...overrides,
  };
}

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('maps the finite query surface to one origin and omits credentials', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ options, url });
    const parsed = new URL(url);
    if (parsed.pathname === QUERY_ROUTE_PATHS.chains) {
      return jsonResponse({ data: [1729], status: 200, total: 1 });
    }
    if (parsed.pathname === `${QUERY_ROUTE_PATHS.packages}/reya-omnibus`) {
      return jsonResponse({
        data: [packageDocument()],
        status: 200,
        total: 1,
      });
    }
    if (
      parsed.pathname ===
      `${QUERY_ROUTE_PATHS.packages}/reya-omnibus%3A1.2.3%40main/1729`
    ) {
      return jsonResponse({ data: packageDocument(), status: 200 });
    }
    if (parsed.pathname === QUERY_ROUTE_PATHS.search) {
      return jsonResponse(searchResponse());
    }
    if (parsed.pathname === QUERY_ROUTE_PATHS.selector) {
      return jsonResponse({
        results: { [SELECTOR]: [selectorDocument()] },
        status: 200,
      });
    }
    throw new Error('unexpected route');
  };
  const client = clientWith(fetchImpl);

  const chains = await client.query.chains();
  const packages = await client.query.packagesByName({
    packageName: 'reya-omnibus',
  });
  const exactPackage = await client.query.packageByRef({
    fullPackageRef: 'reya-omnibus:1.2.3@main',
  });
  const search = await client.query.search({
    query: 'reya-omnibus',
    types: ['package'],
  });
  const selector = await client.query.selector({
    selectors: [SELECTOR],
    type: 'function',
  });

  assert.equal(chains.data[0], 1729);
  assert.equal(packages.data[0].chainId, 1729);
  assert.equal(exactPackage.data.deployUrl, `ipfs://${DEPLOY_CID}`);
  assert.equal(search.data[0].type, 'package');
  assert.equal(selector.results[SELECTOR][0].type, 'function');
  for (const result of [chains, packages, exactPackage, search, selector]) {
    assert.ok(Object.isFrozen(result));
  }

  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      `${SERVICE_ORIGIN}/query/chains`,
      `${SERVICE_ORIGIN}/query/packages/reya-omnibus?chainIds=1729`,
      `${SERVICE_ORIGIN}/query/packages/reya-omnibus%3A1.2.3%40main/1729`,
      `${SERVICE_ORIGIN}/query/search?chainIds=1729&query=reya-omnibus&types=package`,
      `${SERVICE_ORIGIN}/query/selector?chainIds=1729&q=0x8da5cb5b&type=function`,
    ]
  );
  for (const { options, url } of requests) {
    assert.equal(new URL(url).origin, SERVICE_ORIGIN);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal('Authorization' in options.headers, false);
    assert.equal('body' in options, false);
  }
});

test('accepts every finite PR13 document variant for chain 1729', async () => {
  const documents = [
    { count: 1, name: 'reya-omnibus', type: 'namespace' },
    packageDocument({ metaUrl: '', miscUrl: `ipfs://${DEPLOY_CID}` }),
    {
      address: '0x0000000000000000000000000000000000000001',
      chainId: 1729,
      name: 'CoreProxy',
      packageName: 'reya-omnibus',
      preset: 'main',
      type: 'contract',
      version: '1.2.3',
    },
    selectorDocument(),
    {
      name: 'Unauthorized()',
      selector: '0x82b42900',
      type: 'error',
    },
  ];
  const response = searchResponse({
    data: documents,
    query: 'owner',
    total: documents.length,
  });
  const client = clientWith(async () => jsonResponse(response));

  const result = await client.query.search({ query: 'owner' });

  assert.deepEqual(
    result.data.map(({ type }) => type),
    ['namespace', 'package', 'contract', 'function', 'error']
  );
  assert.ok(Object.isFrozen(result.data));
  assert.ok(Object.isFrozen(result.data[0]));
});

test('enforces the bounded canonical ABI signature conformance vectors', () => {
  assert.ok(Object.isFrozen(ABI_SIGNATURE_CONFORMANCE_VECTORS));
  assert.ok(Object.isFrozen(ABI_SIGNATURE_CONFORMANCE_VECTORS.accepted));
  assert.ok(Object.isFrozen(ABI_SIGNATURE_CONFORMANCE_VECTORS.rejected));

  for (const signature of ABI_SIGNATURE_CONFORMANCE_VECTORS.accepted) {
    assert.equal(
      isCanonicalAbiSignature(signature),
      true,
      `expected accepted signature: ${signature}`
    );
  }
  for (const signature of ABI_SIGNATURE_CONFORMANCE_VECTORS.rejected) {
    assert.equal(
      isCanonicalAbiSignature(signature),
      false,
      `expected rejected signature: ${signature}`
    );
  }
});

test('binds package, search, and selector responses to the exact request', async () => {
  const cases = [
    [
      (client) =>
        client.query.packagesByName({ packageName: 'reya-omnibus' }),
      {
        data: [packageDocument({ name: 'other-package' })],
        status: 200,
        total: 1,
      },
    ],
    [
      (client) =>
        client.query.packageByRef({
          fullPackageRef: 'reya-omnibus:1.2.3@main',
        }),
      {
        data: packageDocument({ version: '9.9.9' }),
        status: 200,
      },
    ],
    [
      (client) => client.query.search({ query: 'reya-omnibus' }),
      searchResponse({ query: 'other-package' }),
    ],
    [
      (client) => client.query.search({ query: 'reya-omnibus' }),
      searchResponse({ isHex: true }),
    ],
    [
      (client) => client.query.search({ query: 'reya-omnibus' }),
      searchResponse({
        data: [
          selectorDocument({
            name: 'transfer(address,uint256)',
          }),
        ],
      }),
    ],
    [
      (client) =>
        client.query.search({
          query: 'reya-omnibus',
          types: ['contract'],
        }),
      searchResponse(),
    ],
    [
      (client) => client.query.selector({ selectors: [SELECTOR] }),
      {
        results: {
          [SELECTOR]: [
            selectorDocument({
              selector: '0x82b42900',
            }),
          ],
        },
        status: 200,
      },
    ],
    [
      (client) =>
        client.query.selector({
          selectors: [SELECTOR],
          type: 'function',
        }),
      {
        results: {
          [SELECTOR]: [
            selectorDocument({
              type: 'error',
            }),
          ],
        },
        status: 200,
      },
    ],
    [
      (client) => client.query.selector({ selectors: [SELECTOR] }),
      {
        results: {
          [SELECTOR]: [
            selectorDocument({
              name: 'transfer(address,uint256)',
            }),
          ],
        },
        status: 200,
      },
    ],
  ];

  for (const [invoke, response] of cases) {
    const client = clientWith(async () => jsonResponse(response));
    await assert.rejects(
      () => invoke(client),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('fails closed when ABI selector integrity verification does not return true', async () => {
  for (const verifyAbiSelector of [
    () => false,
    () => 'true',
    async () => false,
    async () => {
      throw new Error('private verifier details');
    },
  ]) {
    const client = clientWith(
      async () =>
        jsonResponse({
          results: { [SELECTOR]: [selectorDocument()] },
          status: 200,
        }),
      { verifyAbiSelector }
    );

    await assert.rejects(
      () =>
        client.query.selector({
          selectors: [SELECTOR],
          type: 'function',
        }),
      (error) => {
        assertClientError('RESPONSE_REJECTED')(error);
        assert.doesNotMatch(error.message, /verifier|private/i);
        return true;
      }
    );
  }
});

test('validates a bounded multi-chain index but exposes only Reya chain 1729', async () => {
  const client = clientWith(async () =>
    jsonResponse({
      data: [1, 10, 1729, 8453],
      status: 200,
      total: 4,
    })
  );

  assert.deepEqual(await client.query.chains(), {
    data: [1729],
    status: 200,
    total: 1,
  });
});

test('rejects every query input outside the reviewed contract', async () => {
  const client = clientWith(async () => {
    throw new Error('invalid input must not reach fetch');
  });
  const symbolKeyedSearch = { query: 'reya' };
  symbolKeyedSearch[Symbol('bearerToken')] = 'secret';
  const invalidCalls = [
    () => client.query.chains({ chainId: 1 }),
    () => client.query.search(null),
    () => client.query.search({ query: '' }),
    () => client.query.search({ query: '---' }),
    () => client.query.search({ query: '___' }),
    () => client.query.search({ query: ' reya' }),
    () => client.query.search({ query: 'reya ' }),
    () => client.query.search({ query: `reya\u0000` }),
    () => client.query.search({ query: 'x'.repeat(257) }),
    () => client.query.search({ query: 'reya', token: 'secret' }),
    () => client.query.search(symbolKeyedSearch),
    () => client.query.search({ query: 'reya', types: [] }),
    () =>
      client.query.search({
        query: 'reya',
        types: ['package', 'package'],
      }),
    () => client.query.search({ query: 'reya', types: ['unsupported'] }),
    () => client.query.search({ query: 'reya', types: ['event'] }),
    () => client.query.search({ query: 'reya' }, {}),
    () =>
      client.query.search({
        query: '0x000000000000000000000000000000000000000A',
      }),
    () => client.query.packagesByName({ packageName: 'ab' }),
    () => client.query.packagesByName({ packageName: 'Reya' }),
    () =>
      client.query.packagesByName({
        packageName: 'reya-omnibus',
        chainId: 1729,
      }),
    () =>
      client.query.packagesByName(
        { packageName: 'reya-omnibus' },
        { chainId: 1729 }
      ),
    () =>
      client.query.packageByRef({
        fullPackageRef: 'reya-omnibus:1.2.3',
      }),
    () =>
      client.query.packageByRef({
        fullPackageRef: `reya-omnibus:${'v'.repeat(33)}@main`,
      }),
    () =>
      client.query.packageByRef({
        fullPackageRef: 'reya-omnibus:1.2.3@../main',
      }),
    () =>
      client.query.packageByRef(
        { fullPackageRef: 'reya-omnibus:1.2.3@main' },
        {}
      ),
    () => client.query.selector({ selectors: [] }),
    () => client.query.selector({ selectors: ['0x8DA5CB5B'] }),
    () => client.query.selector({ selectors: [`0x${'ab'.repeat(32)}`] }),
    () => client.query.selector({ selectors: [SELECTOR, SELECTOR] }),
    () =>
      client.query.selector({
        selectors: Array.from(
          { length: 21 },
          (_, index) => `0x${index.toString(16).padStart(8, '0')}`
        ),
      }),
    () =>
      client.query.selector({
        selectors: [SELECTOR],
        type: 'constructor',
      }),
    () =>
      client.query.selector({
        selectors: [SELECTOR],
        type: 'event',
      }),
    () =>
      client.query.selector({
        selectors: [SELECTOR],
        bearerToken: 'secret',
      }),
    () => client.query.selector({ selectors: [SELECTOR] }, {}),
  ];

  for (const invoke of invalidCalls) {
    await assert.rejects(invoke, assertClientError('INVALID_INPUT'));
  }
});

test('binds a raw search request to the API-normalized echoed query', async () => {
  let requestedUrl;
  const client = clientWith(async (url) => {
    requestedUrl = url;
    return jsonResponse(searchResponse({ data: [], query: 'owner', total: 0 }));
  });

  const result = await client.query.search({ query: 'owner()' });

  assert.equal(
    requestedUrl,
    `${SERVICE_ORIGIN}/query/search?chainIds=1729&query=owner%28%29`
  );
  assert.equal(result.query, 'owner');
});

test('recomputes deterministic search classification flags', async () => {
  const cases = [
    [
      '0x0000000000000000000000000000000000000001',
      {
        isAddress: true,
        isHex: true,
        query: '0x0000000000000000000000000000000000000001',
      },
    ],
    [
      `0x${'ab'.repeat(32)}`,
      {
        isTx: true,
        query: `0x${'ab'.repeat(32)}`,
      },
    ],
    [
      SELECTOR,
      {
        isFunctionSelector: true,
        isHex: true,
        query: SELECTOR,
      },
    ],
    [
      'valid-package:1.2.3@main',
      {
        isPackageRef: true,
        query: 'valid-package123main',
      },
    ],
    [
      `valid-package:${'v'.repeat(33)}@main`,
      {
        isPackageRef: false,
        query: `valid-package${'v'.repeat(33)}main`,
      },
    ],
    [
      'CoreProxy',
      {
        isContractName: true,
        query: 'coreproxy',
      },
    ],
  ];

  for (const [query, overrides] of cases) {
    const client = clientWith(async () =>
      jsonResponse(
        searchResponse({
          data: [],
          total: 0,
          ...overrides,
        })
      )
    );
    await client.query.search({ query });
  }
});

test('fails closed on malformed or cross-chain response schemas', async () => {
  const tooManyDocuments = Array.from({ length: 501 }, () => packageDocument());
  const malformedSearchResponses = [
    { ...searchResponse(), status: 201 },
    { ...searchResponse(), owner: 'raw-redis-field' },
    { ...searchResponse(), isAddress: 'false' },
    { ...searchResponse(), total: -1 },
    { ...searchResponse(), total: 0 },
    { ...searchResponse(), data: tooManyDocuments, total: 501 },
    searchResponse({
      data: [packageDocument({ chainId: 1 })],
    }),
    searchResponse({
      data: [packageDocument({ deployUrl: 'ipfs://not-a-cid' })],
    }),
    searchResponse({
      data: [
        {
          ...packageDocument(),
          owner: '0x0000000000000000000000000000000000000001',
        },
      ],
    }),
    searchResponse({
      data: [
        selectorDocument({
          packageName: undefined,
        }),
      ],
    }),
    searchResponse({
      data: [
        {
          name: 'owner()',
          selector: SELECTOR,
          type: 'function',
          address: '0x0000000000000000000000000000000000000001',
        },
      ],
    }),
    searchResponse({
      data: [
        {
          name: 'foo((uint256)',
          selector: '0x12345678',
          type: 'function',
        },
      ],
    }),
    searchResponse({
      data: [
        {
          name: 'foo(uint)',
          selector: '0x12345678',
          type: 'function',
        },
      ],
    }),
    searchResponse({
      data: [
        {
          name: 'OwnershipTransferred(address,address)',
          selector: '0x8be0079c',
          type: 'event',
        },
      ],
    }),
    searchResponse({
      data: [
        {
          count: '1',
          name: 'reya-omnibus',
          type: 'namespace',
        },
      ],
    }),
  ];

  for (const response of malformedSearchResponses) {
    const client = clientWith(async () => jsonResponse(response));
    await assert.rejects(
      () => client.query.search({ query: 'reya' }),
      assertClientError('RESPONSE_REJECTED')
    );
  }

  const routeFailures = [
    [(client) => client.query.chains(), { data: [1], status: 200, total: 1 }],
    [
      (client) => client.query.chains(),
      { data: [1729], status: 200, total: 0 },
    ],
    [
      (client) => client.query.chains(),
      { data: [1729, 1729], status: 200, total: 2 },
    ],
    [
      (client) => client.query.chains(),
      { data: [1729, '8453'], status: 200, total: 2 },
    ],
    [
      (client) => client.query.packagesByName({ packageName: 'reya-omnibus' }),
      {
        data: [{ ...packageDocument(), rawRedis: true }],
        status: 200,
        total: 1,
      },
    ],
    [
      (client) =>
        client.query.packageByRef({
          fullPackageRef: 'reya-omnibus:1.2.3@main',
        }),
      { data: packageDocument() },
    ],
    [
      (client) => client.query.selector({ selectors: [SELECTOR] }),
      { results: { '0x82b42900': [] }, status: 200 },
    ],
    [
      (client) => client.query.selector({ selectors: [SELECTOR] }),
      {
        results: {
          [SELECTOR]: Array.from({ length: 11 }, () => selectorDocument()),
        },
        status: 200,
      },
    ],
  ];

  for (const [invoke, response] of routeFailures) {
    const client = clientWith(async () => jsonResponse(response));
    await assert.rejects(
      () => invoke(client),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('rejects malformed JSON, wrong media types, and oversized bodies', async () => {
  const cases = [
    jsonResponse('{', { contentLength: false }),
    jsonResponse(searchResponse(), {
      headers: { 'content-type': 'text/html' },
    }),
    jsonResponse(searchResponse(), {
      headers: { 'content-length': '999999999999999999999' },
    }),
    streamResponse([new Uint8Array(REYA_READ_LIMITS.queryBytes + 1)], {
      contentType: 'application/json',
    }),
  ];

  for (const response of cases) {
    const client = clientWith(async () => response);
    await assert.rejects(
      () => client.query.search({ query: 'reya' }),
      assertClientError('RESPONSE_REJECTED')
    );
  }
});

test('accepts gzip and Brotli responses while capping decoded bytes', async (context) => {
  const document = JSON.stringify(searchResponse());
  const encoded = {
    br: brotliCompressSync(document),
    gzip: gzipSync(document),
  };
  const server = createServer((request, response) => {
    const encoding = request.url === '/br' ? 'br' : 'gzip';
    const body = encoded[encoding];
    response.writeHead(200, {
      'content-encoding': encoding,
      'content-length': String(body.byteLength),
      'content-type': 'application/json',
    });
    response.end(body);
  });
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  for (const encoding of ['gzip', 'br']) {
    const client = clientWith((_url, options) =>
      fetch(`http://127.0.0.1:${address.port}/${encoding}`, options)
    );
    const result = await client.query.search({ query: 'reya-omnibus' });
    assert.equal(result.data[0].name, 'reya-omnibus');
  }
});

test('cancels unread or partial bodies on HTTP, header, and streamed-cap failures', async () => {
  const scenarios = [
    {
      headers: { 'content-type': 'application/json' },
      status: 503,
    },
    {
      headers: { 'content-type': 'text/html' },
      status: 200,
    },
    {
      headers: {
        'content-length': String(REYA_READ_LIMITS.queryBytes + 1),
        'content-type': 'application/json',
      },
      status: 200,
    },
  ];

  for (const scenario of scenarios) {
    let cancellations = 0;
    const stream = new ReadableStream({
      cancel() {
        cancellations += 1;
      },
    });
    const client = clientWith(async () => new Response(stream, scenario));

    await assert.rejects(
      () => client.query.search({ query: 'reya' }),
      (error) => {
        assert.ok(
          error.code === 'REQUEST_FAILED' || error.code === 'RESPONSE_REJECTED'
        );
        return true;
      }
    );
    assert.equal(cancellations, 1);
  }

  let partialCancellations = 0;
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(REYA_READ_LIMITS.queryBytes + 1));
    },
    cancel() {
      partialCancellations += 1;
    },
  });
  const client = clientWith(
    async () =>
      new Response(oversized, {
        headers: { 'content-type': 'application/json' },
      })
  );
  await assert.rejects(
    () => client.query.search({ query: 'reya' }),
    assertClientError('RESPONSE_REJECTED')
  );
  assert.equal(partialCancellations, 1);
});

test('redacts HTTP, redirect, and network failures without a fallback request', async () => {
  const secret =
    'https://attacker.example/path?bearer=super-secret-response-body';
  const responses = [
    new Response(secret, {
      headers: { 'content-type': 'application/json' },
      status: 500,
    }),
    (() => {
      const response = jsonResponse(searchResponse());
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    })(),
  ];

  for (const response of responses) {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return response;
    });
    await assert.rejects(
      () => client.query.search({ query: 'reya' }),
      (error) => {
        assertClientError('REQUEST_FAILED')(error);
        assert.doesNotMatch(error.message, /attacker|secret|500/i);
        return true;
      }
    );
    assert.equal(calls, 1);
  }

  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error(secret);
  });
  await assert.rejects(
    () => client.query.search({ query: 'reya' }),
    (error) => {
      assertClientError('REQUEST_FAILED')(error);
      assert.doesNotMatch(error.message, /attacker|secret/i);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('enforces one deadline across stalled fetch headers and streamed body', async () => {
  const deadlines = {
    artifactDeadlineMs: 25,
    queryDeadlineMs: 15,
  };

  const stalledHeaders = clientWith(
    async (_url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error('transport aborted')),
          { once: true }
        );
      }),
    { deadlines }
  );
  await assert.rejects(
    () => stalledHeaders.query.search({ query: 'reya' }),
    assertClientError('REQUEST_TIMEOUT')
  );

  const stalledBody = clientWith(
    async (_url, options) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":'));
          options.signal.addEventListener(
            'abort',
            () => controller.error(new Error('stream aborted')),
            { once: true }
          );
        },
      });
      return new Response(stream, {
        headers: { 'content-type': 'application/json' },
      });
    },
    { deadlines }
  );
  await assert.rejects(
    () => stalledBody.query.search({ query: 'reya' }),
    assertClientError('REQUEST_TIMEOUT')
  );
});
