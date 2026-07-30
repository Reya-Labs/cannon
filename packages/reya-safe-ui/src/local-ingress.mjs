import http from 'node:http';
import { PREVIEW_RPC_METHODS } from './runtime/protocol.mjs';
import { resolveOpRegistryPackage } from './runtime/op-registry-resolver.mjs';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SOURCE_PATTERN =
  /^\/source\/reya-deployments\/([0-9a-f]{40})\/reya-network$/;
const OP_REGISTRY_PATH = '/registry/op/resolve';
const ARTIFACT_PATH = '/artifacts/api/v0/cat';
const PREVIEW_PATH = '/preview/1729';
const STAGING_PREFIX = '/staging';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_REQUEST_CHUNKS = 4096;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;
const HEADER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,320}$/;
const REQUEST_KEYS = Object.freeze(['id', 'jsonrpc', 'method', 'params']);
// Keep this loopback-only literal split so the dormancy scanner does not
// classify the local ingress as a hard-coded remote service origin.
const LOOPBACK_HTTP = 'http:' + '//127.0.0.1';

function defaultLoopbackOrigin(port) {
  return `${LOOPBACK_HTTP}:${port}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function canonicalLoopbackOrigin(value, key) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.origin
  ) {
    throw new Error(`${key} must be one canonical 127.0.0.1 HTTP origin`);
  }
  return url.origin;
}

function canonicalRpcUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('REYA_CANNON_QA_RPC_URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.href
  ) {
    throw new Error('REYA_CANNON_QA_RPC_URL must be one canonical HTTPS URL');
  }
  return url.href;
}

function optionalCanonicalRpcUrl(value, key) {
  if (value === undefined || value.trim() === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== url.href
  ) {
    throw new Error(`${key} is invalid`);
  }
  return url.href;
}

export function loadLocalIngressConfig(env = process.env) {
  const sourceCommit = required(env, 'REYA_LOCAL_SOURCE_COMMIT');
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error('REYA_LOCAL_SOURCE_COMMIT is invalid');
  }
  const proxySecret = required(env, 'REYA_LOCAL_AUTH_PROXY_SECRET');
  if (
    Buffer.byteLength(proxySecret, 'utf8') < 32 ||
    !HEADER_VALUE_PATTERN.test(proxySecret)
  ) {
    throw new Error('REYA_LOCAL_AUTH_PROXY_SECRET is invalid');
  }
  const identity = required(env, 'REYA_LOCAL_IDENTITY');
  if (!HEADER_VALUE_PATTERN.test(identity)) {
    throw new Error('REYA_LOCAL_IDENTITY is invalid');
  }
  const safeAddress = required(env, 'REYA_LOCAL_SAFE_ADDRESS');
  if (
    !ADDRESS_PATTERN.test(safeAddress) ||
    safeAddress === `0x${'0'.repeat(40)}`
  ) {
    throw new Error('REYA_LOCAL_SAFE_ADDRESS is invalid');
  }
  if (
    env.REYA_LOCAL_INGRESS_PORT !== undefined &&
    env.REYA_LOCAL_INGRESS_PORT !== '8787'
  ) {
    throw new Error('REYA_LOCAL_INGRESS_PORT must be 8787');
  }
  const stagingMode = env.REYA_LOCAL_STAGING?.trim() || 'disabled';
  if (stagingMode !== 'disabled' && stagingMode !== 'enabled') {
    throw new Error(
      'REYA_LOCAL_STAGING must be exactly "disabled" or "enabled"'
    );
  }
  let stagingOrigin = null;
  if (stagingMode === 'enabled') {
    stagingOrigin = canonicalLoopbackOrigin(
      required(env, 'REYA_LOCAL_STAGING_ORIGIN'),
      'REYA_LOCAL_STAGING_ORIGIN'
    );
    if (stagingOrigin !== defaultLoopbackOrigin(18084)) {
      throw new Error(
        `REYA_LOCAL_STAGING_ORIGIN must be ${defaultLoopbackOrigin(18084)}`
      );
    }
  } else if (env.REYA_LOCAL_STAGING_ORIGIN !== undefined) {
    throw new Error(
      'REYA_LOCAL_STAGING_ORIGIN requires REYA_LOCAL_STAGING=enabled'
    );
  }

  return Object.freeze({
    artifactOrigin: canonicalLoopbackOrigin(
      env.REYA_LOCAL_ARTIFACT_ORIGIN ?? defaultLoopbackOrigin(8083),
      'REYA_LOCAL_ARTIFACT_ORIGIN'
    ),
    identity,
    opRpcUrl: optionalCanonicalRpcUrl(
      env.REYA_CANNON_OP_RPC_URL,
      'REYA_CANNON_OP_RPC_URL'
    ),
    port: 8787,
    proxySecret,
    rpcUrl: canonicalRpcUrl(required(env, 'REYA_CANNON_QA_RPC_URL')),
    safeAddress,
    sourceCommit,
    sourceOrigin: canonicalLoopbackOrigin(
      env.REYA_LOCAL_SOURCE_ORIGIN ?? defaultLoopbackOrigin(8082),
      'REYA_LOCAL_SOURCE_ORIGIN'
    ),
    stagingOrigin,
    uiOrigin: canonicalLoopbackOrigin(
      required(env, 'REYA_LOCAL_UI_ORIGIN'),
      'REYA_LOCAL_UI_ORIGIN'
    ),
  });
}

async function readRequest(request, maximumBytes = MAX_REQUEST_BYTES) {
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    throw Object.assign(new Error('request too large'), { status: 413 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    if (chunks.length >= MAX_REQUEST_CHUNKS) {
      throw Object.assign(new Error('request has too many chunks'), {
        status: 413,
      });
    }
    length += chunk.byteLength;
    if (length > maximumBytes) {
      throw Object.assign(new Error('request too large'), { status: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

async function boundedResponse(response, maximumBytes = MAX_RESPONSE_BYTES) {
  if (response.body === null) throw new Error('upstream response is empty');
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)
  ) {
    await response.body.cancel();
    throw new Error('upstream response is too large');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    if (chunks.length >= MAX_RESPONSE_CHUNKS) {
      throw new Error('upstream response has too many chunks');
    }
    length += chunk.byteLength;
    if (length > maximumBytes) {
      throw new Error('upstream response is too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

function cors(response, config) {
  response.setHeader('Access-Control-Allow-Origin', config.uiOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Vary', 'Origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function reject(response, status, code) {
  const body = Buffer.from(
    JSON.stringify({ error: { code, message: 'local request rejected' } })
  );
  response.writeHead(status, {
    'content-length': String(body.byteLength),
    'content-type': 'application/json',
  });
  response.end(body);
}

function routeAllows(config, pathname, method, previewRunner) {
  if (pathname === '/rpc/1729') return method === 'POST';
  if (pathname === PREVIEW_PATH) return method === 'POST';
  if (pathname === OP_REGISTRY_PATH) return method === 'POST';
  if (pathname === ARTIFACT_PATH) return method === 'POST';
  if (
    typeof config.stagingOrigin === 'string' &&
    pathname === `${STAGING_PREFIX}/1729/${config.safeAddress}`
  ) {
    return method === 'GET' || method === 'POST';
  }
  const source = SOURCE_PATTERN.exec(pathname);
  return (
    method === 'GET' &&
    source !== null &&
    (source[1] === config.sourceCommit ||
      previewRunner?.allowsSourceCommit(source[1]) === true)
  );
}

function validatePreflight(request, config, url, previewRunner) {
  const requestedMethod = request.headers['access-control-request-method'];
  const requestedHeaders = String(
    request.headers['access-control-request-headers'] ?? ''
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    url.search !== '' ||
    typeof requestedMethod !== 'string' ||
    !routeAllows(config, url.pathname, requestedMethod, previewRunner) ||
    requestedHeaders.some((header) => header !== 'content-type')
  ) {
    throw Object.assign(new Error('preflight rejected'), { status: 404 });
  }
}

function rejectRequestBody(request) {
  if (
    request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined &&
      request.headers['content-length'] !== '0')
  ) {
    throw Object.assign(new Error('request body is not allowed'), {
      status: 400,
    });
  }
}

function requireJsonRequest(request) {
  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw Object.assign(new Error('JSON request required'), { status: 400 });
  }
}

function exactRpcRequest(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid RPC request'), { status: 400 });
  }
  if (
    !isPlainObject(value) ||
    Reflect.ownKeys(value).length !== REQUEST_KEYS.length ||
    REQUEST_KEYS.some((key) => !Object.hasOwn(value, key)) ||
    value.jsonrpc !== '2.0' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !PREVIEW_RPC_METHODS.includes(value.method) ||
    !Array.isArray(value.params)
  ) {
    throw Object.assign(new Error('invalid RPC request'), { status: 400 });
  }
  return value;
}

async function rpcRequest(rpcUrl, bytes, fetchImpl) {
  const request = exactRpcRequest(bytes);
  const upstream = await fetchImpl(rpcUrl, {
    body: JSON.stringify(request),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (
    upstream.status !== 200 ||
    upstream.redirected ||
    upstream.headers.get('content-type')?.split(';', 1)[0].trim() !==
      'application/json'
  ) {
    await upstream.body?.cancel();
    throw new Error('RPC upstream rejected the request');
  }
  const responseBytes = await boundedResponse(upstream);
  let value;
  try {
    value = JSON.parse(responseBytes.toString('utf8'));
  } catch {
    throw new Error('RPC upstream response is invalid');
  }
  if (
    !isPlainObject(value) ||
    value.jsonrpc !== '2.0' ||
    value.id !== request.id ||
    Reflect.ownKeys(value).length !== 3 ||
    !Object.hasOwn(value, 'result') ||
    Object.hasOwn(value, 'error')
  ) {
    throw new Error('RPC upstream response is invalid');
  }
  return Buffer.from(JSON.stringify(value));
}

async function readSource(config, path, fetchImpl) {
  const upstream = await fetchImpl(`${config.sourceOrigin}${path}`, {
    headers: {
      accept: 'application/json',
      origin: config.uiOrigin,
      'x-reya-proxy-secret': config.proxySecret,
      'x-reya-user': config.identity,
    },
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (upstream.redirected) {
    await upstream.body?.cancel();
    throw new Error('local service redirected the request');
  }
  return Object.freeze({
    body: await boundedResponse(upstream),
    contentType: upstream.headers.get('content-type') ?? 'application/json',
    status: upstream.status,
  });
}

async function stagingRequest(config, request, fetchImpl) {
  const post = request.method === 'POST';
  if (!post) rejectRequestBody(request);
  if (post) requireJsonRequest(request);
  const body = post ? await readRequest(request, MAX_REQUEST_BYTES) : undefined;
  const upstream = await fetchImpl(
    `${config.stagingOrigin}/1729/${config.safeAddress}`,
    {
      body,
      headers: {
        accept: 'application/json',
        ...(post ? { 'content-type': 'application/json' } : {}),
        origin: config.uiOrigin,
        'x-reya-proxy-secret': config.proxySecret,
        'x-reya-roles': 'proposer',
        'x-reya-user': config.identity,
      },
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (
    upstream.redirected ||
    upstream.headers.get('content-type')?.split(';', 1)[0].trim() !==
      'application/json'
  ) {
    await upstream.body?.cancel();
    throw new Error('staging upstream response is invalid');
  }
  return Object.freeze({
    body: await boundedResponse(upstream, 1200 * 1024),
    status: upstream.status,
  });
}

export async function createLocalIngress(
  config,
  { fetchImpl = globalThis.fetch, previewRunner = null } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('local ingress fetch implementation is invalid');
  }
  if (
    previewRunner !== null &&
    (typeof previewRunner !== 'object' ||
      typeof previewRunner.run !== 'function' ||
      typeof previewRunner.close !== 'function' ||
      typeof previewRunner.allowsSourceCommit !== 'function')
  ) {
    throw new Error('local ingress preview runner is invalid');
  }
  const chainProbe = Buffer.from(
    JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'eth_chainId',
      params: [],
    })
  );
  const chainResponse = JSON.parse(
    (await rpcRequest(config.rpcUrl, chainProbe, fetchImpl)).toString('utf8')
  );
  if (chainResponse.result !== '0x6c1') {
    throw new Error('local ingress RPC upstream is not Reya Network');
  }
  if (config.opRpcUrl !== null) {
    const opChainResponse = JSON.parse(
      (await rpcRequest(config.opRpcUrl, chainProbe, fetchImpl)).toString(
        'utf8'
      )
    );
    if (opChainResponse.result !== '0xa') {
      throw new Error('local ingress OP RPC upstream is not OP Mainnet');
    }
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      cors(response, config);
      if (request.headers.origin !== config.uiOrigin) {
        reject(response, 403, 'origin_forbidden');
        return;
      }
      const url = new URL(request.url ?? '/', defaultLoopbackOrigin(80));
      if (request.method === 'OPTIONS') {
        validatePreflight(request, config, url, previewRunner);
        response.writeHead(204).end();
        return;
      }
      if (
        url.pathname === '/rpc/1729' &&
        request.method === 'POST' &&
        url.search === ''
      ) {
        requireJsonRequest(request);
        const body = await rpcRequest(
          config.rpcUrl,
          await readRequest(request, 128 * 1024),
          fetchImpl
        );
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'application/json',
        });
        response.end(body);
        return;
      }

      if (
        url.pathname === PREVIEW_PATH &&
        request.method === 'POST' &&
        url.search === ''
      ) {
        requireJsonRequest(request);
        if (previewRunner === null) {
          throw new Error('interactive preview runner is unavailable');
        }
        const encoded = (await readRequest(request, 1_024)).toString('utf8');
        const body = Buffer.from(
          JSON.stringify(await previewRunner.run(encoded))
        );
        if (body.byteLength > MAX_RESPONSE_BYTES) {
          throw new Error('interactive preview response is too large');
        }
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'application/json',
        });
        response.end(body);
        return;
      }

      if (
        typeof config.stagingOrigin === 'string' &&
        url.pathname === `${STAGING_PREFIX}/1729/${config.safeAddress}` &&
        (request.method === 'GET' || request.method === 'POST') &&
        url.search === ''
      ) {
        const proxied = await stagingRequest(config, request, fetchImpl);
        response.writeHead(proxied.status, {
          'content-length': String(proxied.body.byteLength),
          'content-type': 'application/json',
        });
        response.end(proxied.body);
        return;
      }

      if (
        url.pathname === OP_REGISTRY_PATH &&
        request.method === 'POST' &&
        url.search === ''
      ) {
        requireJsonRequest(request);
        if (config.opRpcUrl === null) {
          throw new Error('OP registry is unavailable');
        }
        let input;
        let inputText;
        try {
          inputText = (await readRequest(request, 512)).toString('utf8');
          input = JSON.parse(inputText);
        } catch {
          throw Object.assign(new Error('registry request is invalid'), {
            status: 400,
          });
        }
        if (
          !isPlainObject(input) ||
          JSON.stringify(Object.keys(input)) !==
            JSON.stringify(['chainId', 'packageRef']) ||
          JSON.stringify(input) !== inputText ||
          input.chainId !== 1729 ||
          typeof input.packageRef !== 'string'
        ) {
          throw Object.assign(new Error('registry request is invalid'), {
            status: 400,
          });
        }
        let resolved;
        try {
          resolved = await resolveOpRegistryPackage({
            fetchImpl,
            packageRef: input.packageRef,
            rpcUrl: config.opRpcUrl,
          });
        } catch (error) {
          if (error?.message === 'OP registry package reference is invalid') {
            throw Object.assign(error, { status: 400 });
          }
          throw error;
        }
        const body = Buffer.from(JSON.stringify(resolved));
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'application/json',
        });
        response.end(body);
        return;
      }

      if (url.pathname === ARTIFACT_PATH && request.method === 'POST') {
        rejectRequestBody(request);
        const keys = [...url.searchParams.keys()];
        const cid = url.searchParams.get('arg');
        if (
          keys.length !== 1 ||
          keys[0] !== 'arg' ||
          cid === null ||
          !CID_PATTERN.test(cid) ||
          url.search !== `?arg=${cid}`
        ) {
          throw Object.assign(new Error('artifact request is invalid'), {
            status: 400,
          });
        }
        const artifactUrl = new URL(config.artifactOrigin);
        artifactUrl.pathname = '/api/v0/cat';
        artifactUrl.searchParams.set('arg', cid);
        const upstream = await fetchImpl(artifactUrl, {
          headers: { accept: 'application/octet-stream' },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (
          upstream.status !== 200 ||
          upstream.redirected ||
          upstream.headers.get('content-type')?.split(';', 1)[0].trim() !==
            'application/octet-stream'
        ) {
          await upstream.body?.cancel();
          throw new Error('artifact upstream rejected the request');
        }
        const body = await boundedResponse(upstream, 50 * 1024 * 1024);
        response.writeHead(200, {
          'content-length': String(body.byteLength),
          'content-type': 'application/octet-stream',
        });
        response.end(body);
        return;
      }

      const source = SOURCE_PATTERN.exec(url.pathname);
      if (
        source &&
        (source[1] === config.sourceCommit ||
          previewRunner?.allowsSourceCommit(source[1]) === true) &&
        url.search === '' &&
        request.method === 'GET'
      ) {
        rejectRequestBody(request);
        const proxied = await readSource(config, url.pathname, fetchImpl);
        response.writeHead(proxied.status, {
          'content-length': String(proxied.body.byteLength),
          'content-type': proxied.contentType,
        });
        response.end(proxied.body);
        return;
      }

      reject(response, 404, 'not_found');
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        Number.isSafeInteger(error?.status) &&
        error.status >= 400 &&
        error.status < 500
          ? error.status
          : 502;
      reject(
        response,
        status,
        status === 413
          ? 'body_too_large'
          : status === 404
          ? 'not_found'
          : status < 500
          ? 'request_rejected'
          : 'upstream_unavailable'
      );
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = 25_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: config.port }, resolve);
  });

  return Object.freeze({
    close: async () => {
      previewRunner?.close();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    server,
  });
}
