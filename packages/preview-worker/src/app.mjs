import { authenticate, requireAnyRole } from './auth.mjs';
import { PreviewError, toPublicError } from './errors.mjs';
import {
  MAX_PREVIEW_REQUEST_BYTES,
  MAX_REGISTRY_REQUEST_BYTES,
  parsePreviewRequest,
  parseRegistryRequest,
} from './request.mjs';

const PREVIEW_PATH = '/preview/1729';
const REGISTRY_PATH = '/registry/op/resolve';
const HEALTH_PATHS = Object.freeze(['/livez', '/readyz']);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const ALLOWED_METHODS = 'POST,OPTIONS';

/**
 * Every route this worker will ever serve. There is deliberately no execute,
 * broadcast, sign, submit or approve path: staging a proposal is the staging
 * backend's job and executing one is out of scope pending a separate review.
 */
export const ROUTES = Object.freeze([
  Object.freeze({ method: 'POST', path: PREVIEW_PATH }),
  Object.freeze({ method: 'POST', path: REGISTRY_PATH }),
]);

function securityHeaders(response, config, reflectOrigin) {
  if (reflectOrigin) {
    response.setHeader('Access-Control-Allow-Origin', config.uiOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    response.setHeader('Access-Control-Max-Age', '600');
  }
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'");
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Vary', 'Origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    const overflow = Buffer.from(
      JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE' } }),
    );
    response.writeHead(502, {
      'content-length': String(overflow.byteLength),
      'content-type': 'application/json',
    });
    response.end(overflow);
    return;
  }
  response.writeHead(status, {
    'content-length': String(body.byteLength),
    'content-type': 'application/json',
  });
  response.end(body);
}

function sendError(response, error) {
  const publicError = toPublicError(error);
  sendJson(response, publicError.status, {
    error: { code: publicError.code },
  });
}

function requireJsonMediaType(request) {
  const contentType = request.headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
  ) {
    throw new PreviewError(415, 'INVALID_REQUEST');
  }
  if (request.headers['content-encoding'] !== undefined) {
    throw new PreviewError(415, 'INVALID_REQUEST');
  }
}

async function readBody(request, maximumBytes) {
  const declared = request.headers['content-length'];
  if (
    request.headers['transfer-encoding'] !== undefined ||
    typeof declared !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(declared) ||
    Number(declared) > maximumBytes
  ) {
    throw new PreviewError(413, 'BODY_TOO_LARGE');
  }
  // The byte cap already bounds both memory and iteration count, so there is
  // no separate chunk cap: one would only add a way to reject a valid small
  // body that a proxy or TLS layer happened to fragment.
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.byteLength;
    if (length > maximumBytes) {
      throw new PreviewError(413, 'BODY_TOO_LARGE');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (length !== Number(declared)) {
    throw new PreviewError(400, 'INVALID_REQUEST');
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

function matchRoute(url, method) {
  const route = ROUTES.find(({ path }) => path === url.pathname);
  if (route === undefined) throw new PreviewError(404, 'NOT_FOUND');
  if (url.search !== '') throw new PreviewError(400, 'INVALID_REQUEST');
  if (route.method !== method)
    throw new PreviewError(405, 'METHOD_NOT_ALLOWED');
  return route;
}

/**
 * Builds the finite production request handler.
 *
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @param {{previewRunner: {run: Function}, registryResolver: {resolve: Function}}} services
 */
export function createApp(config, { previewRunner, registryResolver }) {
  if (
    previewRunner === null ||
    typeof previewRunner !== 'object' ||
    typeof previewRunner.run !== 'function' ||
    registryResolver === null ||
    typeof registryResolver !== 'object' ||
    typeof registryResolver.resolve !== 'function'
  ) {
    throw new Error('preview worker services are invalid');
  }

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://preview.invalid');

      // Kubelet probes carry no browser origin and no identity. They expose no
      // configuration, upstream state or version detail.
      if (HEALTH_PATHS.includes(url.pathname)) {
        if (request.method !== 'GET') {
          throw new PreviewError(405, 'METHOD_NOT_ALLOWED');
        }
        securityHeaders(response, config, false);
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      const origin = request.headers.origin;
      if (origin !== config.uiOrigin) {
        securityHeaders(response, config, false);
        throw new PreviewError(403, 'ORIGIN_FORBIDDEN');
      }
      securityHeaders(response, config, true);

      if (request.method === 'OPTIONS') {
        const requestedMethod =
          request.headers['access-control-request-method'];
        const requestedHeaders = String(
          request.headers['access-control-request-headers'] ?? '',
        )
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        matchRoute(url, requestedMethod);
        if (requestedHeaders.some((header) => header !== 'content-type')) {
          throw new PreviewError(403, 'FORBIDDEN');
        }
        response.writeHead(204).end();
        return;
      }

      const route = matchRoute(url, request.method);
      const actor = authenticate(request, config);
      requireAnyRole(actor, 'operator', 'proposer', 'signer');
      requireJsonMediaType(request);

      if (route.path === REGISTRY_PATH) {
        const parsed = parseRegistryRequest(
          await readBody(request, MAX_REGISTRY_REQUEST_BYTES),
          { chainId: config.chainId },
        );
        sendJson(response, 200, await registryResolver.resolve(parsed));
        return;
      }

      const parsed = parsePreviewRequest(
        await readBody(request, MAX_PREVIEW_REQUEST_BYTES),
        { chainId: config.chainId, safeAddress: config.safeAddress },
      );
      sendJson(response, 200, await previewRunner.run(parsed, { actor }));
    })().catch((error) => {
      // This is the last handler on the request. A throw here would become an
      // unhandled rejection and take the process down, so an aborted client —
      // whose socket may already be gone — must never be able to reach that.
      try {
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        sendError(response, error);
      } catch {
        try {
          response.destroy();
        } catch {
          // The socket is already gone; there is nothing left to release.
        }
      }
    });
  };
}
