import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  stringToHex,
  zeroAddress,
} from 'viem';
import { OP_CHAIN_ID, REYA_CHAIN_ID } from './config.mjs';
import { PreviewError } from './errors.mjs';
import { ethCall } from './rpc.mjs';

export const OP_REGISTRY_ADDRESS = '0x8e5c7efc9636a6a0408a46bb7f617094b81e5dba';
export const OP_PACKAGE_NAME = 'reya-omnibus';
export const OP_PACKAGE_PRESET = 'main';

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const PACKAGE_REF_PATTERN =
  /^reya-omnibus:((?:latest|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?))@main$/;
const MUTABILITY_VALUES = Object.freeze(['', 'tag', 'version']);

export const OP_REGISTRY_ABI = Object.freeze([
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

function decodeRegistryResult(result, packageRef) {
  let decoded;
  try {
    decoded = decodeFunctionResult({
      abi: OP_REGISTRY_ABI,
      data: result,
      functionName: 'getPackageInfo',
    });
  } catch {
    throw new PreviewError(502, 'REGISTRY_UNAVAILABLE');
  }
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    typeof decoded.owner !== 'string' ||
    typeof decoded.deployUrl !== 'string' ||
    typeof decoded.mutability !== 'string'
  ) {
    throw new PreviewError(502, 'REGISTRY_UNAVAILABLE');
  }

  const base = {
    chainId: REYA_CHAIN_ID,
    packageRef,
    registryAddress: OP_REGISTRY_ADDRESS,
    registryChainId: OP_CHAIN_ID,
    schemaVersion: 1,
  };

  // An unowned or empty entry is a legitimate "not published" answer, not a
  // failure: the caller may still supply an exact previous-package CID.
  if (decoded.owner === zeroAddress || decoded.deployUrl === '') {
    return Object.freeze({
      ...base,
      cid: null,
      deployUrl: null,
      found: false,
      mutability: null,
    });
  }

  const cid = decoded.deployUrl.startsWith('ipfs://')
    ? decoded.deployUrl.slice('ipfs://'.length)
    : '';
  let mutability;
  try {
    mutability = hexToString(decoded.mutability, { size: 16 }).replace(
      /\0+$/u,
      '',
    );
  } catch {
    throw new PreviewError(502, 'REGISTRY_UNAVAILABLE');
  }
  if (
    !CID_PATTERN.test(cid) ||
    decoded.deployUrl !== `ipfs://${cid}` ||
    !MUTABILITY_VALUES.includes(mutability)
  ) {
    throw new PreviewError(502, 'REGISTRY_UNAVAILABLE');
  }
  return Object.freeze({
    ...base,
    cid,
    deployUrl: decoded.deployUrl,
    found: true,
    mutability,
  });
}

/**
 * Resolves the temporary OP Mainnet package alias on the server.
 *
 * OP Mainnet is only a package-reference registry: it stores no artifact and
 * executes no deployment. The browser never learns the OP RPC endpoint, and a
 * caller that already holds an exact previous-package CID bypasses this route
 * entirely.
 *
 * @param {{fetchImpl?: typeof fetch, opRpcUrl: string}} options
 */
export function createRegistryResolver({ fetchImpl, opRpcUrl }) {
  if (typeof opRpcUrl !== 'string' || opRpcUrl.length < 1) {
    throw new Error('OP registry resolver configuration is invalid');
  }
  return Object.freeze({
    async resolve({ packageRef }) {
      const match = PACKAGE_REF_PATTERN.exec(packageRef ?? '');
      if (match === null || match[1].length > 32) {
        throw new PreviewError(400, 'INVALID_REQUEST');
      }
      let data;
      try {
        data = encodeFunctionData({
          abi: OP_REGISTRY_ABI,
          args: [
            stringToHex(OP_PACKAGE_NAME, { size: 32 }),
            stringToHex(match[1], { size: 32 }),
            stringToHex(`${REYA_CHAIN_ID}-${OP_PACKAGE_PRESET}`, { size: 32 }),
          ],
          functionName: 'getPackageInfo',
        });
      } catch {
        throw new PreviewError(400, 'INVALID_REQUEST');
      }
      let result;
      try {
        result = await ethCall({
          data,
          fetchImpl,
          to: OP_REGISTRY_ADDRESS,
          url: opRpcUrl,
        });
      } catch {
        // Collapse every OP failure — including a pruned-state rejection, which
        // is meaningless for a `latest` alias read — into one opaque code.
        throw new PreviewError(502, 'REGISTRY_UNAVAILABLE');
      }
      return decodeRegistryResult(result, packageRef);
    },
  });
}
