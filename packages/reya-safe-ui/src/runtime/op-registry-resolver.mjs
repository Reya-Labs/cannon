import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  stringToHex,
  zeroAddress,
} from 'viem';

export const OP_REGISTRY_ADDRESS = '0x8e5c7efc9636a6a0408a46bb7f617094b81e5dba';
export const OP_REGISTRY_CHAIN_ID = 10;
export const REYA_TARGET_CHAIN_ID = 1729;

export const OP_REGISTRY_GET_PACKAGE_INFO_ABI = Object.freeze([
  Object.freeze({
    inputs: Object.freeze([
      Object.freeze({ name: '_packageName', type: 'bytes32' }),
      Object.freeze({ name: '_packageVersionName', type: 'bytes32' }),
      Object.freeze({ name: '_packageVariant', type: 'bytes32' }),
    ]),
    name: 'getPackageInfo',
    outputs: Object.freeze([
      Object.freeze({
        components: Object.freeze([
          Object.freeze({ name: 'owner', type: 'address' }),
          Object.freeze({ name: 'deployUrl', type: 'string' }),
          Object.freeze({ name: 'metaUrl', type: 'string' }),
          Object.freeze({ name: 'mutability', type: 'bytes16' }),
          Object.freeze({ name: '__reserved', type: 'bytes16' }),
        ]),
        name: '',
        type: 'tuple',
      }),
    ]),
    stateMutability: 'view',
    type: 'function',
  }),
]);

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const PACKAGE_REF_PATTERN =
  /^reya-omnibus:((?:latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?))@main$/;
const HASH_PATTERN = /^0x[0-9a-f]+$/;
const MAX_RPC_BYTES = 128 * 1024;

function canonicalPackageRef(value) {
  if (typeof value !== 'string') {
    throw new Error('OP registry package reference is invalid');
  }
  const match = PACKAGE_REF_PATTERN.exec(value);
  if (!match || match[1].length > 32) {
    throw new Error('OP registry package reference is invalid');
  }
  return Object.freeze({
    packageRef: value,
    version: match[1],
  });
}

async function boundedBody(response) {
  if (response.body === null) {
    throw new Error('OP registry response is unavailable');
  }
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_RPC_BYTES)
  ) {
    await response.body.cancel();
    throw new Error('OP registry response is invalid');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new Error('OP registry response is invalid');
      }
      length += part.value.byteLength;
      if (length > MAX_RPC_BYTES) {
        throw new Error('OP registry response is invalid');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length
  );
}

function decodedResult(result, packageRef) {
  let decoded;
  try {
    decoded = decodeFunctionResult({
      abi: OP_REGISTRY_GET_PACKAGE_INFO_ABI,
      data: result,
      functionName: 'getPackageInfo',
    });
  } catch {
    throw new Error('OP registry response is invalid');
  }
  const deployUrl = decoded?.deployUrl;
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    typeof decoded.owner !== 'string' ||
    typeof deployUrl !== 'string' ||
    typeof decoded.mutability !== 'string'
  ) {
    throw new Error('OP registry response is invalid');
  }
  if (decoded.owner === zeroAddress || deployUrl === '') {
    return Object.freeze({
      chainId: REYA_TARGET_CHAIN_ID,
      cid: null,
      deployUrl: null,
      found: false,
      mutability: null,
      packageRef,
      registryAddress: OP_REGISTRY_ADDRESS,
      registryChainId: OP_REGISTRY_CHAIN_ID,
      schemaVersion: 1,
    });
  }
  const cid = deployUrl.startsWith('ipfs://')
    ? deployUrl.slice('ipfs://'.length)
    : '';
  let mutability;
  try {
    mutability = hexToString(decoded.mutability, { size: 16 }).replace(
      /\0+$/u,
      ''
    );
  } catch {
    throw new Error('OP registry response is invalid');
  }
  if (
    !CID_PATTERN.test(cid) ||
    deployUrl !== `ipfs://${cid}` ||
    !['', 'tag', 'version'].includes(mutability)
  ) {
    throw new Error('OP registry response is invalid');
  }
  return Object.freeze({
    chainId: REYA_TARGET_CHAIN_ID,
    cid,
    deployUrl,
    found: true,
    mutability,
    packageRef,
    registryAddress: OP_REGISTRY_ADDRESS,
    registryChainId: OP_REGISTRY_CHAIN_ID,
    schemaVersion: 1,
  });
}

export async function resolveOpRegistryPackage({
  fetchImpl = globalThis.fetch,
  packageRef,
  rpcUrl,
}) {
  if (typeof fetchImpl !== 'function' || typeof rpcUrl !== 'string') {
    throw new Error('OP registry resolver options are invalid');
  }
  const canonical = canonicalPackageRef(packageRef);
  const callData = encodeFunctionData({
    abi: OP_REGISTRY_GET_PACKAGE_INFO_ABI,
    args: [
      stringToHex('reya-omnibus', { size: 32 }),
      stringToHex(canonical.version, { size: 32 }),
      stringToHex(`${REYA_TARGET_CHAIN_ID}-main`, { size: 32 }),
    ],
    functionName: 'getPackageInfo',
  });
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [
          {
            data: callData,
            to: OP_REGISTRY_ADDRESS,
          },
          'latest',
        ],
      }),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new Error('OP registry is unavailable');
  }
  if (
    response.status !== 200 ||
    response.redirected ||
    response.headers.get('content-type')?.split(';', 1)[0].trim() !==
      'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('OP registry is unavailable');
  }
  let body;
  try {
    body = JSON.parse((await boundedBody(response)).toString('utf8'));
  } catch {
    throw new Error('OP registry response is invalid');
  }
  if (
    body === null ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Reflect.ownKeys(body).length !== 3 ||
    body.id !== 1 ||
    body.jsonrpc !== '2.0' ||
    typeof body.result !== 'string' ||
    !HASH_PATTERN.test(body.result) ||
    Object.hasOwn(body, 'error')
  ) {
    throw new Error('OP registry response is invalid');
  }
  return decodedResult(body.result, canonical.packageRef);
}
