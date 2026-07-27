import {
  createReyaReadOnlyClients,
  REYA_CHAIN_ID,
} from '../src/clients/index.mjs';

export const SERVICE_ORIGIN = 'https://cannon-api.reya-tailnet.ts.net';
export const DEPLOY_CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
export const META_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const ABI_SELECTORS = new Map([
  ['owner()', '0x8da5cb5b'],
  ['transfer(address,uint256)', '0xa9059cbb'],
  ['Unauthorized()', '0x82b42900'],
]);

export function verifyAbiSelector(name, selector) {
  return ABI_SELECTORS.get(name) === selector;
}

export function clientWith(fetchImpl, overrides = {}) {
  return createReyaReadOnlyClients({
    fetchImpl,
    serviceOrigin: SERVICE_ORIGIN,
    verifyAbiSelector,
    verifyArtifactCid: async () => DEPLOY_CID,
    ...overrides,
  });
}

export function jsonResponse(value, options = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }
  if (options.contentLength !== false && !headers.has('content-length')) {
    headers.set(
      'content-length',
      String(new TextEncoder().encode(body).length)
    );
  }
  return new Response(body, {
    headers,
    status: options.status ?? 200,
  });
}

export function byteResponse(bytes, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/octet-stream');
  }
  if (options.contentLength !== false && !headers.has('content-length')) {
    headers.set('content-length', String(bytes.byteLength));
  }
  return new Response(bytes, {
    headers,
    status: options.status ?? 200,
  });
}

export function streamResponse(chunks, options = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.close !== false) controller.close();
    },
  });
  const headers = new Headers(options.headers);
  headers.set(
    'content-type',
    options.contentType ?? 'application/octet-stream'
  );
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength));
  }
  return new Response(stream, { headers, status: options.status ?? 200 });
}

export function packageDocument(overrides = {}) {
  return {
    chainId: REYA_CHAIN_ID,
    deployUrl: `ipfs://${DEPLOY_CID}`,
    metaUrl: `ipfs://${META_CID}`,
    name: 'reya-omnibus',
    preset: 'main',
    publisher: '0x0000000000000000000000000000000000000001',
    timestamp: 1_700_000_000,
    type: 'package',
    version: '1.2.3',
    ...overrides,
  };
}

export function searchResponse(overrides = {}) {
  return {
    data: [packageDocument()],
    isAddress: false,
    isContractName: false,
    isFunctionSelector: false,
    isHex: false,
    isPackageRef: false,
    isTx: false,
    query: 'reya-omnibus',
    status: 200,
    total: 1,
    ...overrides,
  };
}
