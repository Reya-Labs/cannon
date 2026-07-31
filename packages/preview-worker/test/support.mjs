import http from 'node:http';
import { createApp } from '../src/app.mjs';

export const UI_ORIGIN = 'https://cannon.reya.xyz';
export const SAFE_ADDRESS = '0x1fe50318e5e3165742edc9c4a15d997bdb935eb9';
export const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';
export const PREVIOUS_CID = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
export const PARTIAL_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
export const PROXY_SECRET = 'k'.repeat(48);

export const ENV = Object.freeze({
  AUTH_PROXY_SECRET: PROXY_SECRET,
  PREVIEW_ARTIFACT_ORIGIN: 'http://artifacts.reya-ops.svc.cluster.local:8080',
  PREVIEW_OP_RPC_URL: 'https://op.example.invalid/v1/token',
  PREVIEW_PREVIOUS_PACKAGE_CID: PREVIOUS_CID,
  PREVIEW_RPC_URL: 'https://rpc.example.invalid/v1/token',
  PREVIEW_SAFE_ADDRESS: SAFE_ADDRESS,
  PREVIEW_SOURCE_COMMIT: COMMIT,
  PREVIEW_SOURCE_ORIGIN: 'http://source.reya-ops.svc.cluster.local:8080',
  PREVIEW_UI_ORIGIN: UI_ORIGIN,
});

export function previewBody(overrides = {}) {
  return JSON.stringify({
    chainId: 1729,
    commit: COMMIT,
    partialDeployCid: null,
    previousPackageCid: PREVIOUS_CID,
    safeAddress: SAFE_ADDRESS,
    ...overrides,
  });
}

export function authHeaders(overrides = {}) {
  return {
    'content-type': 'application/json',
    origin: UI_ORIGIN,
    'x-reya-proxy-secret': PROXY_SECRET,
    'x-reya-roles': 'proposer',
    'x-reya-user': 'signer@reya.xyz',
    ...overrides,
  };
}

/**
 * Starts one app on an ephemeral loopback port and returns a bounded client.
 * Tests exercise the real HTTP framing rather than calling handlers directly,
 * so header-duplication and body-framing defences are actually covered.
 */
export async function withServer(
  { previewRunner, registryResolver, config } = {},
  run,
) {
  const { loadConfig } = await import('../src/config.mjs');
  const app = createApp(config ?? loadConfig({ ...ENV }), {
    previewRunner: previewRunner ?? {
      run: async () => ({ ok: true }),
    },
    registryResolver: registryResolver ?? {
      resolve: async () => ({ ok: true }),
    },
  });
  const server = http.createServer(app);
  await new Promise((resolve) =>
    server.listen({ host: '127.0.0.1', port: 0 }, resolve),
  );
  const { port } = server.address();
  try {
    return await run({
      port,
      request: (path, options = {}) => rawRequest(port, path, options),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Issues one request using raw header lines so a test can send the same header
 * twice — something `fetch` silently folds together.
 */
function rawRequest(
  port,
  path,
  { body, headers = {}, method = 'GET', rawHeaderLines = [] },
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const request = http.request(
      {
        headers: {
          ...headers,
          ...(payload === undefined
            ? {}
            : { 'content-length': String(payload.byteLength) }),
        },
        host: '127.0.0.1',
        method,
        path,
        port,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            body: text,
            headers: response.headers,
            json: () => JSON.parse(text),
            status: response.statusCode,
          });
        });
      },
    );
    for (const [name, value] of rawHeaderLines) {
      request.setHeader(name, value);
    }
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
