import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  stringToHex,
} from 'viem';
import { OP_CHAIN_ID, REYA_CHAIN_ID } from '../config.mjs';
import { PreviewError } from '../errors.mjs';
import { OP_REGISTRY_ABI, OP_REGISTRY_ADDRESS } from '../registry.mjs';
import { ethCall } from '../rpc.mjs';

export const ETHEREUM_CHAIN_ID = 1;

// The Cannon registry is deployed at the same address on OP Mainnet and
// Ethereum Mainnet, and is read in that order — the same fallback order the
// Cannon CLI uses, so a preview resolves the package a `cannon build` would.
export const CANNON_REGISTRY_ADDRESS = OP_REGISTRY_ADDRESS;

export const REGISTRY_RPC_ORDER = Object.freeze([
  OP_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
]);

export const MAX_REGISTRY_LOOKUPS = 256;

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const IPFS_URL_PATTERN = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const NAME_PATTERN = /^[a-z0-9][A-Za-z0-9-]{1,}[a-z0-9]$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MUTABILITY_VALUES = Object.freeze(['', 'tag', 'version']);

function reject() {
  throw new PreviewError(502, 'PREVIEW_FAILED');
}

/**
 * Parses one Cannon package reference the way `PackageReference` does, but
 * refusing anything that would not fit the registry's `bytes32` fields rather
 * than truncating it. `name:version@preset`; version defaults to `latest` and
 * preset to `main`.
 */
export function parsePackageReference(reference) {
  if (typeof reference !== 'string' || reference.length > 128) return null;
  const match = /^([^:@]+)(?::([^@]+))?(?:@(.+))?$/.exec(reference);
  if (match === null) return null;
  const name = match[1];
  const version = match[2] ?? 'latest';
  const preset = match[3] ?? 'main';
  if (
    !NAME_PATTERN.test(name) ||
    Buffer.byteLength(name, 'utf8') > 32 ||
    !VERSION_PATTERN.test(version) ||
    Buffer.byteLength(version, 'utf8') > 32 ||
    !PRESET_PATTERN.test(preset) ||
    Buffer.byteLength(preset, 'utf8') > 24
  ) {
    return null;
  }
  return Object.freeze({
    fullPackageRef: `${name}:${version}@${preset}`,
    name,
    preset,
    version,
  });
}

function contentAddress(reference) {
  if (typeof reference !== 'string') return null;
  if (CID_PATTERN.test(reference)) return `ipfs://${reference}`;
  const match = IPFS_URL_PATTERN.exec(reference);
  return match === null ? null : `ipfs://${match[1]}`;
}

function decodePackageInfo(result) {
  let decoded;
  try {
    decoded = decodeFunctionResult({
      abi: OP_REGISTRY_ABI,
      data: result,
      functionName: 'getPackageInfo',
    });
  } catch {
    reject();
  }
  if (
    decoded === null ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    typeof decoded.deployUrl !== 'string' ||
    typeof decoded.mutability !== 'string'
  ) {
    reject();
  }
  if (decoded.deployUrl === '') {
    return Object.freeze({ mutability: '', url: null });
  }
  const match = IPFS_URL_PATTERN.exec(decoded.deployUrl);
  if (match === null) reject();
  let mutability;
  try {
    mutability = hexToString(decoded.mutability, { size: 16 }).replace(
      /\0+$/u,
      '',
    );
  } catch {
    reject();
  }
  if (!MUTABILITY_VALUES.includes(mutability)) reject();
  return Object.freeze({ mutability, url: `ipfs://${match[1]}` });
}

/**
 * Creates the read-mostly Cannon registry the preview build runs against.
 *
 * Three things make this safe to hand to the builder:
 *
 * - the previous package is **pinned**, not looked up. The request already
 *   names the exact previous-package CID, so a registry that started answering
 *   a different CID for `reya-omnibus:<version>@main` cannot move the baseline
 *   a preview is diffed against;
 * - every other reference is resolved by an `eth_call` against the immutable
 *   Cannon registry on OP Mainnet and then Ethereum Mainnet. There is no
 *   hosted-Cannon or public-IPFS fallback: an unresolved reference returns
 *   `null` and the build fails closed;
 * - writes never leave the process. The builder publishes intermediate
 *   packages while it works; those land in an overlay and are accepted only
 *   for CIDs this run itself produced or verified.
 *
 * @param {{
 *   allowedCids: Set<string>,
 *   fetchImpl?: typeof fetch,
 *   mainnetRpcUrl: string,
 *   opRpcUrl: string,
 *   previousPackage: {cid: string, fullPackageRef: string},
 *   signal?: AbortSignal,
 * }} options
 */
export function createPreviewRegistry({
  allowedCids,
  fetchImpl,
  mainnetRpcUrl,
  opRpcUrl,
  previousPackage,
  signal,
}) {
  if (
    !(allowedCids instanceof Set) ||
    typeof mainnetRpcUrl !== 'string' ||
    mainnetRpcUrl.length < 1 ||
    typeof opRpcUrl !== 'string' ||
    opRpcUrl.length < 1 ||
    previousPackage === null ||
    typeof previousPackage !== 'object' ||
    typeof previousPackage.cid !== 'string' ||
    !CID_PATTERN.test(previousPackage.cid) ||
    parsePackageReference(previousPackage.fullPackageRef) === null
  ) {
    throw new Error('preview registry configuration is invalid');
  }
  const pinned = new Map();
  const overlay = new Map();
  const resolved = new Map();
  let lookups = 0;

  const key = (chainId, fullPackageRef) => `${chainId}:${fullPackageRef}`;
  pinned.set(
    key(
      REYA_CHAIN_ID,
      parsePackageReference(previousPackage.fullPackageRef).fullPackageRef,
    ),
    Object.freeze({
      mutability: 'version',
      url: `ipfs://${previousPackage.cid}`,
    }),
  );
  allowedCids.add(previousPackage.cid);

  async function readOnChain(url, parsed, chainId) {
    const variant = `${chainId}-${parsed.preset}`;
    let data;
    try {
      data = encodeFunctionData({
        abi: OP_REGISTRY_ABI,
        args: [
          stringToHex(parsed.name, { size: 32 }),
          stringToHex(parsed.version, { size: 32 }),
          stringToHex(variant, { size: 32 }),
        ],
        functionName: 'getPackageInfo',
      });
    } catch {
      // A reference that cannot be expressed in the registry's `bytes32`
      // fields is unresolvable, not silently truncated into another package.
      reject();
    }
    return decodePackageInfo(
      await ethCall({
        data,
        fetchImpl,
        signal,
        to: CANNON_REGISTRY_ADDRESS,
        url,
      }),
    );
  }

  return Object.freeze({
    getLabel() {
      return 'pinned previous package plus on-chain Cannon registry';
    },
    async getAllUrls() {
      return new Set([
        ...[...pinned.values()].map(({ url }) => url),
        ...overlay.values(),
      ]);
    },
    async getMetaUrl() {
      return null;
    },
    async getUrl(reference, chainId) {
      const direct = contentAddress(reference);
      if (direct !== null)
        return Object.freeze({ mutability: '', url: direct });
      const parsed = parsePackageReference(reference);
      if (parsed === null || !Number.isSafeInteger(chainId) || chainId < 1) {
        return Object.freeze({ mutability: '', url: null });
      }
      const cacheKey = key(chainId, parsed.fullPackageRef);
      // What keeps the baseline immovable is `publish` refusing a pinned key
      // outright — a loud rejection, and the behaviour the tests hold. Reading
      // the pin first is only an order, not a second check: the write guard
      // means the overlay can never hold a pinned key for it to shadow.
      const pin = pinned.get(cacheKey);
      if (pin !== undefined) return pin;
      const overlaid = overlay.get(cacheKey);
      if (overlaid !== undefined) {
        return Object.freeze({ mutability: 'version', url: overlaid });
      }
      const cached = resolved.get(cacheKey);
      if (cached !== undefined) return cached;

      // The lookup budget is per preview, not per reference, so a definition
      // that fans out cannot turn one request into an unbounded RPC spend.
      lookups += 1;
      if (lookups > MAX_REGISTRY_LOOKUPS) reject();

      let answer = Object.freeze({ mutability: '', url: null });
      for (const url of REGISTRY_RPC_ORDER.map((registryChainId) =>
        registryChainId === OP_CHAIN_ID ? opRpcUrl : mainnetRpcUrl,
      )) {
        const candidate = await readOnChain(url, parsed, chainId);
        if (candidate.url !== null) {
          answer = candidate;
          break;
        }
      }
      if (answer.url !== null) {
        allowedCids.add(answer.url.slice('ipfs://'.length));
      }
      resolved.set(cacheKey, answer);
      return answer;
    },
    async publish(packageNames, chainId, url) {
      const match = typeof url === 'string' ? IPFS_URL_PATTERN.exec(url) : null;
      if (
        !Array.isArray(packageNames) ||
        packageNames.length < 1 ||
        packageNames.length > 32 ||
        match === null ||
        !allowedCids.has(match[1]) ||
        !Number.isSafeInteger(chainId) ||
        chainId < 1
      ) {
        throw new Error('preview registry write is outside the run');
      }
      const keys = packageNames.map((reference) => {
        const parsed = parsePackageReference(reference);
        if (parsed === null) {
          throw new Error('preview registry write reference is invalid');
        }
        return key(chainId, parsed.fullPackageRef);
      });
      if (new Set(keys).size !== keys.length) {
        throw new Error('preview registry write contains duplicate references');
      }
      if (keys.some((cacheKey) => pinned.has(cacheKey))) {
        throw new Error('preview registry write targets a pinned package');
      }
      const receipts = [];
      for (const cacheKey of keys) {
        overlay.set(cacheKey, `ipfs://${match[1]}`);
        receipts.push(`preview-${receipts.length + 1}`);
      }
      return receipts;
    },
  });
}
