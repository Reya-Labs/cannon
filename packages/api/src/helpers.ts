import * as viem from 'viem';
import { PackageReference } from '@usecannon/builder';
import { BadRequestError, ServerError } from './errors';
import { ApiDocumentType, RedisPackage, RedisTag } from './types';

const packageNameRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]$/;
export function isPackageName(packageName: unknown): packageName is string {
  return typeof packageName === 'string' && packageNameRegex.test(packageName);
}

export function parsePackageName(packageName: string) {
  if (!isPackageName(packageName)) {
    throw new BadRequestError('Invalid package name');
  }

  return packageName.replace(/-/g, '\\-');
}

const MAX_PACKAGE_REF_LENGTH = 256;
const partialPackageRefRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]:[^@]+(?:@[^\s]+)?$/;
export function isPartialPackageRef(packageName: unknown): packageName is string {
  return (
    typeof packageName === 'string' &&
    packageName.length <= MAX_PACKAGE_REF_LENGTH &&
    partialPackageRefRegex.test(packageName) &&
    PackageReference.isValid(packageName)
  );
}

const fullPackageRefRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]:[^@]+@[^\s]+$/;
export function isFullPackageRef(fullPackageRef: unknown): fullPackageRef is string {
  return (
    typeof fullPackageRef === 'string' &&
    fullPackageRef.length <= MAX_PACKAGE_REF_LENGTH &&
    fullPackageRefRegex.test(fullPackageRef) &&
    PackageReference.isValid(fullPackageRef)
  );
}

const contractNameRegex = /^[A-Z][A-Za-z0-9_]*$/;
export function isContractName(contractName: unknown) {
  return typeof contractName === 'string' && contractNameRegex.test(contractName);
}

const functionSelectorRegex = /^0x[0-9a-fA-F]{8}$/;
export function isFunctionSelector(selector: unknown) {
  return typeof selector === 'string' && functionSelectorRegex.test(selector);
}

export function isAbiSignature(signature: unknown): signature is string {
  if (typeof signature !== 'string' || signature.length > 512) return false;

  try {
    const item = viem.parseAbiItem(`function ${signature}`);
    return item.type === 'function' && viem.toFunctionSignature(item) === signature;
  } catch {
    return false;
  }
}

const chainIdRegex = /^[1-9][0-9]*$/;
export function isChainId(chainId: unknown): chainId is string {
  if (typeof chainId !== 'string' || !chainIdRegex.test(chainId)) return false;
  const parsed = Number.parseInt(chainId, 10);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

const MAX_CHAIN_IDS = 20;
export function parseChainIds(chainIds: unknown): number[] {
  if (chainIds === undefined || chainIds === null || chainIds === '') return [];
  if (typeof chainIds !== 'string') throw new BadRequestError('Invalid chainIds parameter');

  const values = chainIds.split(',');
  if (chainIds.length > 512 || values.length > MAX_CHAIN_IDS || values.some((chainId) => !isChainId(chainId))) {
    throw new BadRequestError(`chainIds must contain at most ${MAX_CHAIN_IDS} positive, safe integers`);
  }
  return [...new Set(values.map((chainId) => Number.parseInt(chainId, 10)))];
}

const MAX_TEXT_QUERY_LENGTH = 256;
export function parseTextQuery(query: unknown): string {
  if (query === undefined || query === null || query === '') return '';

  if (typeof query !== 'string' || query.length > MAX_TEXT_QUERY_LENGTH) {
    throw new BadRequestError(`query must be a string of at most ${MAX_TEXT_QUERY_LENGTH} characters`);
  }

  return (
    query
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      // only leave valid characters and remove starting or ending '-'s
      .replace(/^[-_]+|[^a-z0-9-_]|[-_]+$/g, '') || ''
  );
}

const QUERY_TYPES = new Set<ApiDocumentType>(['namespace', 'package', 'contract', 'function', 'error']);
export function parseQueryTypes(type: unknown): ApiDocumentType[] {
  if (type === undefined || type === null || type === '') return [];
  if (typeof type !== 'string' || type.length > 128) throw new BadRequestError('Invalid types parameter');

  const values = type.split(',').map((value) => value.trim().toLowerCase());
  if (!values.length || values.some((value) => !QUERY_TYPES.has(value as ApiDocumentType))) {
    throw new BadRequestError('types contains an unsupported document type');
  }
  return [...new Set(values)] as ApiDocumentType[];
}

const selectorRegex = /^0x[0-9a-fA-F]{8}$/;
const MAX_SELECTORS = 20;
export function parseSelectors(value: unknown): viem.Hex[] {
  if (typeof value !== 'string' || !value) throw new BadRequestError('Query selector not specified');
  const selectors = value.split(',');
  if (
    value.length > MAX_SELECTORS * 67 ||
    selectors.length > MAX_SELECTORS ||
    selectors.some((selector) => !selectorRegex.test(selector))
  ) {
    throw new BadRequestError(`q must contain at most ${MAX_SELECTORS} valid 4-byte selectors`);
  }
  return [...new Set(selectors.map((selector) => selector.toLowerCase()))] as viem.Hex[];
}

export function parseSelectorType(value: unknown): 'function' | 'error' | undefined {
  if (value === undefined) return undefined;
  if (value === 'function' || value === 'error') return value;
  throw new BadRequestError('type must be function or error');
}

export function parseAddresses(addresses: any) {
  if (typeof addresses !== 'string') return [] as viem.Address[];
  const result = addresses.split(',');

  if (result.some((val) => !viem.isAddress(val))) {
    throw new ServerError(`Invalid publishers "${addresses}"`);
  }

  return result as viem.Address[];
}

export function isRedisTagOfPackage(a: RedisPackage, b: RedisTag) {
  return a.name === b.name && a.version === b.versionOfTag && a.preset === b.preset && a.chainId === b.chainId;
}
