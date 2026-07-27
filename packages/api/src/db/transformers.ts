import { getIpfsUrl, PackageReference } from '@usecannon/builder';
import { CID } from 'multiformats/cid';
import * as viem from 'viem';
import { isChainId, isContractName, isFunctionSelector, isRedisTagOfPackage } from '../helpers';
import { ApiSelectorResult, ApiPackage, IpfsUrl, RedisDocument, RedisFunction, RedisPackage, RedisTag } from '../types';

export function findPackageByTag(documents: { value: RedisDocument }[], tag: RedisTag) {
  const result = documents.find(
    (item) =>
      item.value.type === 'package' &&
      item.value.name === tag.name &&
      item.value.preset === tag.preset &&
      item.value.chainId === tag.chainId &&
      item.value.version === tag.versionOfTag
  );

  if (!result) return;

  return result.value as RedisPackage;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return;

  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

function parsePackageReference(name: unknown, version: unknown, preset: unknown): PackageReference | undefined {
  if (typeof name !== 'string' || typeof version !== 'string' || typeof preset !== 'string') return;

  const fullPackageRef = `${name}:${version}@${preset}`;
  return PackageReference.isValid(fullPackageRef) ? new PackageReference(fullPackageRef) : undefined;
}

function parseIpfsUrl(value: unknown): IpfsUrl | undefined {
  const url = getIpfsUrl(value);
  if (!url) return;

  const valueCid = url.slice('ipfs://'.length);
  try {
    const cid = CID.parse(valueCid);
    if (
      cid.version !== 0 ||
      cid.code !== 0x70 ||
      cid.multihash.code !== 0x12 ||
      cid.multihash.size !== 32 ||
      cid.toString() !== valueCid
    ) {
      return;
    }
  } catch {
    return;
  }

  return url as IpfsUrl;
}

export function transformPackage(value: RedisPackage): ApiPackage | undefined {
  if (!value || value.type !== 'package') return;

  const ref = parsePackageReference(value.name, value.version, value.preset);
  const chainId = isChainId(value.chainId) ? Number(value.chainId) : undefined;
  const timestamp = parseTimestamp(value.timestamp);
  const deployUrl = parseIpfsUrl(value.deployUrl);
  const metaUrl = value.metaUrl === '' ? '' : parseIpfsUrl(value.metaUrl);
  const miscUrl = value.miscUrl === undefined || value.miscUrl === '' ? undefined : parseIpfsUrl(value.miscUrl);

  if (
    !ref ||
    chainId === undefined ||
    timestamp === undefined ||
    !deployUrl ||
    metaUrl === undefined ||
    (value.miscUrl !== undefined && value.miscUrl !== '' && miscUrl === undefined) ||
    !viem.isAddress(value.owner)
  ) {
    return;
  }

  return {
    type: 'package',
    name: ref.name,
    version: ref.version,
    preset: ref.preset,
    chainId,
    deployUrl,
    metaUrl,
    ...(miscUrl ? { miscUrl } : {}),
    timestamp,
    publisher: viem.getAddress(value.owner),
  };
}

export function transformPackageWithTag(pkg: RedisPackage, tag: RedisTag): ApiPackage | undefined {
  const transformed = transformPackage(pkg);
  const ref = parsePackageReference(tag.name, tag.tag, tag.preset);
  const chainId = isChainId(tag.chainId) ? Number(tag.chainId) : undefined;
  const timestamp = parseTimestamp(tag.timestamp);

  if (
    !transformed ||
    tag.type !== 'tag' ||
    !ref ||
    chainId === undefined ||
    timestamp === undefined ||
    !isRedisTagOfPackage(pkg, tag)
  ) {
    return;
  }

  return {
    ...transformed,
    name: ref.name,
    version: ref.version,
    preset: ref.preset,
    chainId,
    timestamp,
  };
}

export function transformFunction(value: RedisFunction) {
  if (!value || (value.type !== 'function' && value.type !== 'error')) return;
  if (typeof value.name !== 'string' || !value.name) return;
  if (!isFunctionSelector(value.selector)) return;
  if (parseTimestamp(value.timestamp) === undefined) return;

  if (value.package) {
    if (!PackageReference.isValid(value.package)) return;
    if (!isChainId(value.chainId)) return;
    if (typeof value.address !== 'string' || !viem.isAddress(value.address)) return;
    if (!isContractName(value.contractName)) return;

    const ref = new PackageReference(value.package);
    return {
      type: value.type,
      name: value.name,
      selector: value.selector,
      contractName: value.contractName,
      chainId: Number.parseInt(value.chainId),
      address: viem.getAddress(value.address),
      packageName: ref.name,
      preset: ref.preset,
      version: ref.version,
    } satisfies ApiSelectorResult;
  } else {
    if (value.package !== undefined) return;
    if (value.chainId !== undefined && !isChainId(value.chainId)) return;
    if (value.address !== undefined && !viem.isAddress(value.address)) return;
    if (value.contractName !== undefined && !isContractName(value.contractName)) return;

    return {
      type: value.type,
      name: value.name,
      selector: value.selector,
      contractName: value.contractName,
      chainId: value.chainId ? Number.parseInt(value.chainId) : undefined,
      address: value.address ? viem.getAddress(value.address) : undefined,
    } satisfies ApiSelectorResult;
  }
}
