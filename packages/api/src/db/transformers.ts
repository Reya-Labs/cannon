import { getIpfsUrl, PackageReference } from '@usecannon/builder';
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

const CANNON_CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
function parseIpfsUrl(value: unknown): IpfsUrl | undefined {
  const url = getIpfsUrl(value);
  return url && CANNON_CID_V0.test(url.slice('ipfs://'.length)) ? (url as IpfsUrl) : undefined;
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
  if (!value) return;
  if (typeof value.name !== 'string' || !value.name) return;
  if (!isFunctionSelector(value.selector)) return;
  if (typeof value.timestamp !== 'string' || !value.timestamp) return;
  if (value.package && !PackageReference.isValid(value.package)) return;
  if (value.chainId && !isChainId(value.chainId)) return;
  if (value.address && !viem.isAddress(value.address)) return;
  if (value.contractName && !isContractName(value.contractName)) return;

  if (value.package) {
    const ref = new PackageReference(value.package);
    return {
      type: 'function',
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
    return {
      type: 'function',
      name: value.name,
      selector: value.selector,
      contractName: value.contractName,
      chainId: value.chainId ? Number.parseInt(value.chainId) : undefined,
      address: value.address ? viem.getAddress(value.address) : undefined,
    } satisfies ApiSelectorResult;
  }
}
