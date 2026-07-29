import http from 'node:http';
import { PREVIEW_RPC_METHODS } from './runtime/protocol.mjs';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const STAGING_PATTERN = /^\/staging\/1729\/(0x[0-9a-f]{40})$/;
const SOURCE_PATTERN =
  /^\/source\/reya-deployments\/([0-9a-f]{40})\/reya-network$/;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_REQUEST_CHUNKS = 4096;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 4096;
const HEADER_VALUE_PATTERN = /^[^\u0000-\u001f\u007f]{1,320}$/;
const REQUEST_KEYS = Object.freeze(['id', 'jsonrpc', 'method', 'params']);
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

export function loadLocalIngressConfig(env = process.env) {
  const safeAddress = required(env, 'REYA_LOCAL_SAFE_ADDRESS');
  if (
    !ADDRESS_PATTERN.test(safeAddress) ||
    safeAddress === `0x${'0'.repeat(40)}`
  ) {
    throw new Error('REYA_LOCAL_SAFE_ADDRESS is invalid');
  }
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
  if (
    env.REYA_LOCAL_INGRESS_PORT !== undefined &&
    env.REYA_LOCAL_INGRESS_PORT !== '8787'
  ) {
    throw new Error('REYA_LOCAL_INGRESS_PORT must be 8787');
  }

  return Object.freeze({
    identity,
    port: 8787,
    proxySecret,
    rpcUrl: canonicalRpcUrl(required(env, 'REYA_CANNON_QA_RPC_URL')),
    safeAddress,
    sourceCommit,
    sourceOrigin: canonicalLoopbackOrigin(
      env.REYA_LOCAL_SOURCE_ORIGIN ?? defaultLoopbackOrigin(8082),
      'REYA_LOCAL_SOURCE_ORIGIN'
    ),
    stagingOrigin: canonicalLoopbackOrigin(
      env.REYA_LOCAL_STAGING_ORIGIN ?? defaultLoopbackOrigin(8081),
      'REYA_LOCAL_STAGING_ORIGIN'
    ),
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

async function boundedResponse(response) {
  if (response.body === null) throw new Error('upstream response is empty');
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_RESPONSE_BYTES)
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
    if (length > MAX_RESPONSE_BYTES) {
      throw new Error('upstream response is too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

function cors(response, config) {
  response.setHeader('Access-Control-Allow-Origin', config.uiOrigin);
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,X-Idempotency-Key'
  );
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

function routeAllows(config, pathname, method) {
  if (pathname === '/rpc/1729') return method === 'POST';
  const staging = STAGING_PATTERN.exec(pathname);
  if (staging?.[1] === config.safeAddress) {
    return method === 'GET' || method === 'POST';
  }
  const source = SOURCE_PATTERN.exec(pathname);
  return source?.[1] === config.sourceCommit && method === 'GET';
}

function validatePreflight(request, config, url) {
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
    !routeAllows(config, url.pathname, requestedMethod) ||
    requestedHeaders.some(
      (header) => header !== 'content-type' && header !== 'x-idempotency-key'
    )
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

async function rpcRequest(config, bytes, fetchImpl) {
  const request = exactRpcRequest(bytes);
  const upstream = await fetchImpl(config.rpcUrl, {
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

async function proxyRequest({
  body,
  config,
  fetchImpl,
  idempotencyKey,
  method,
  origin,
  path,
}) {
  const headers = {
    accept: 'application/json',
    origin: config.uiOrigin,
    'x-reya-proxy-secret': config.proxySecret,
    'x-reya-user': config.identity,
  };
  if (origin === config.stagingOrigin) {
    headers['x-reya-roles'] = 'proposer,signer';
  }
  if (body.byteLength > 0) headers['content-type'] = 'application/json';
  if (idempotencyKey !== undefined) {
    if (
      Array.isArray(idempotencyKey) ||
      !/^[a-zA-Z0-9._:-]{16,128}$/.test(idempotencyKey)
    ) {
      throw Object.assign(new Error('idempotency key is invalid'), {
        status: 400,
      });
    }
    headers['x-idempotency-key'] = idempotencyKey;
  }
  const upstream = await fetchImpl(`${origin}${path}`, {
    ...(body.byteLength > 0 ? { body } : {}),
    headers,
    method,
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

export async function createLocalIngress(
  config,
  { fetchImpl = globalThis.fetch } = {}
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('local ingress fetch implementation is invalid');
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
    (await rpcRequest(config, chainProbe, fetchImpl)).toString('utf8')
  );
  if (chainResponse.result !== '0x6c1') {
    throw new Error('local ingress RPC upstream is not Reya Network');
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
        validatePreflight(request, config, url);
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
          config,
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

      const staging = STAGING_PATTERN.exec(url.pathname);
      if (
        staging &&
        staging[1] === config.safeAddress &&
        url.search === '' &&
        (request.method === 'GET' || request.method === 'POST')
      ) {
        if (request.method === 'GET') rejectRequestBody(request);
        else requireJsonRequest(request);
        const proxied = await proxyRequest({
          body:
            request.method === 'POST'
              ? await readRequest(request)
              : Buffer.alloc(0),
          config,
          fetchImpl,
          idempotencyKey: request.headers['x-idempotency-key'],
          method: request.method,
          origin: config.stagingOrigin,
          path: `/1729/${config.safeAddress}`,
        });
        response.writeHead(proxied.status, {
          'content-length': String(proxied.body.byteLength),
          'content-type': proxied.contentType,
        });
        response.end(proxied.body);
        return;
      }

      const source = SOURCE_PATTERN.exec(url.pathname);
      if (
        source &&
        source[1] === config.sourceCommit &&
        url.search === '' &&
        request.method === 'GET'
      ) {
        rejectRequestBody(request);
        const proxied = await proxyRequest({
          body: Buffer.alloc(0),
          config,
          fetchImpl,
          method: 'GET',
          origin: config.sourceOrigin,
          path: url.pathname,
        });
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
        status === 413 ? 'body_too_large' : 'upstream_unavailable'
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
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    server,
  });
}
