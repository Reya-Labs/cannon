import * as viem from 'viem';
import { PackageReference } from '@usecannon/builder';
import { BadRequestError, ServerError } from './errors';
import { ApiDocumentType, RedisPackage, RedisTag } from './types';

const packageNameRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]$/;
/** Returns whether a value is a 3–31 character Cannon package name accepted by ChainDefinition. */
export function isPackageName(packageName: unknown): packageName is string {
  return typeof packageName === 'string' && packageNameRegex.test(packageName);
}

/** Validates and escapes a package name for RediSearch; throws BadRequestError on invalid input. */
export function parsePackageName(packageName: string) {
  if (!isPackageName(packageName)) {
    throw new BadRequestError('Invalid package name');
  }

  return packageName.replace(/-/g, '\\-');
}

const MAX_PACKAGE_REF_LENGTH = 256;
const partialPackageRefRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]:[^@]+(?:@[^\s]+)?$/;
/** Returns whether a value is a valid Cannon partial package reference of at most 256 characters. */
export function isPartialPackageRef(packageName: unknown): packageName is string {
  return (
    typeof packageName === 'string' &&
    packageName.length <= MAX_PACKAGE_REF_LENGTH &&
    partialPackageRefRegex.test(packageName) &&
    PackageReference.isValid(packageName)
  );
}

const fullPackageRefRegex = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]:[^@]+@[^\s]+$/;
/** Returns whether a value is a valid explicit-preset Cannon reference of at most 256 characters. */
export function isFullPackageRef(fullPackageRef: unknown): fullPackageRef is string {
  return (
    typeof fullPackageRef === 'string' &&
    fullPackageRef.length <= MAX_PACKAGE_REF_LENGTH &&
    fullPackageRefRegex.test(fullPackageRef) &&
    PackageReference.isValid(fullPackageRef)
  );
}

const contractNameRegex = /^[A-Z][A-Za-z0-9_]*$/;
/** Returns whether a value starts uppercase and contains only identifier characters. */
export function isContractName(contractName: unknown) {
  return typeof contractName === 'string' && contractNameRegex.test(contractName);
}

const functionSelectorRegex = /^0x[0-9a-fA-F]{8}$/;
/** Returns whether a value is a four-byte EVM function or error selector. */
export function isFunctionSelector(selector: unknown) {
  return typeof selector === 'string' && functionSelectorRegex.test(selector);
}

const MAX_ABI_FIXED_ARRAY_LENGTH = 0xffff_ffff;

/** Shared strict ABI-signature examples that every Reya query consumer must classify identically. */
export const ABI_SIGNATURE_CONFORMANCE_VECTORS = Object.freeze({
  accepted: Object.freeze([
    '$owner()',
    'owner$()',
    'owner()',
    'setConfig((uint256,bool),bytes32[])',
    'setNested((uint256,(address,bool)[]),bytes32[2][])',
    'withBounds(bytes1,bytes32,int8,int256,uint8,uint256)',
    'withFunction(function)',
    'withMaximumArray(uint256[4294967295])',
  ]),
  rejected: Object.freeze([
    '',
    '<img>()',
    'foo(())',
    'foo((uint256)',
    'foo((uint256,))',
    'foo(,)',
    'foo(address payable)',
    'foo(bytes0)',
    'foo(bytes33)',
    'foo(fixed128x18)',
    'foo(int)',
    'foo(ufixed128x18)',
    'foo(uint)',
    'foo(uint256[0])',
    'foo(uint256[01])',
    'foo(uint256[4294967296])',
    'owner',
    'owner ()',
    `owner(${String.fromCharCode(0x202e)}address)`,
  ]),
});

function isCanonicalAbiBaseType(value: string): boolean {
  if (value === 'address' || value === 'bool' || value === 'bytes' || value === 'function' || value === 'string') {
    return true;
  }

  const bytes = /^bytes(?<size>[0-9]+)$/.exec(value);
  if (bytes?.groups) {
    const size = Number(bytes.groups.size);
    return String(size) === bytes.groups.size && size >= 1 && size <= 32;
  }

  const integer = /^(?:u?int)(?<size>[0-9]+)$/.exec(value);
  if (integer?.groups) {
    const size = Number(integer.groups.size);
    return String(size) === integer.groups.size && size >= 8 && size <= 256 && size % 8 === 0;
  }

  return false;
}

function isCanonicalAbiSignature(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;

  let offset = 0;
  const isIdentifierStart = (character: string | undefined) => typeof character === 'string' && /[A-Za-z_$]/.test(character);
  const isIdentifierPart = (character: string | undefined) =>
    typeof character === 'string' && /[A-Za-z0-9_$]/.test(character);

  function parseParameterList(allowEmpty: boolean): boolean {
    if (value[offset] !== '(') return false;
    offset += 1;
    if (value[offset] === ')') {
      if (!allowEmpty) return false;
      offset += 1;
      return true;
    }

    while (offset < value.length) {
      if (!parseType()) return false;
      if (value[offset] === ')') {
        offset += 1;
        return true;
      }
      if (value[offset] !== ',') return false;
      offset += 1;
    }
    return false;
  }

  function parseType(): boolean {
    if (value[offset] === '(') {
      if (!parseParameterList(false)) return false;
    } else {
      const start = offset;
      while (offset < value.length && /[A-Za-z0-9]/.test(value[offset]!)) offset += 1;
      if (offset === start || !isCanonicalAbiBaseType(value.slice(start, offset))) return false;
    }

    while (value[offset] === '[') {
      offset += 1;
      const start = offset;
      while (/[0-9]/.test(value[offset] ?? '')) offset += 1;
      const length = value.slice(start, offset);
      if (length && (!/^[1-9][0-9]*$/.test(length) || length.length > 10 || Number(length) > MAX_ABI_FIXED_ARRAY_LENGTH)) {
        return false;
      }
      if (value[offset] !== ']') return false;
      offset += 1;
    }
    return true;
  }

  if (!isIdentifierStart(value[offset])) return false;
  offset += 1;
  while (isIdentifierPart(value[offset])) offset += 1;
  return parseParameterList(true) && offset === value.length;
}

/**
 * Returns whether a value is a canonical function-style ABI signature in the
 * shared 512-character Reya subset.
 */
export function isAbiSignature(signature: unknown): signature is string {
  if (typeof signature !== 'string' || !isCanonicalAbiSignature(signature)) return false;

  try {
    const item = viem.parseAbiItem(`function ${signature}`);
    return item.type === 'function' && viem.toFunctionSignature(item) === signature;
  } catch {
    return false;
  }
}

const chainIdRegex = /^[1-9][0-9]*$/;
/** Returns whether a value encodes a positive JavaScript-safe chain identifier. */
export function isChainId(chainId: unknown): chainId is string {
  if (typeof chainId !== 'string' || !chainIdRegex.test(chainId)) return false;
  const parsed = Number.parseInt(chainId, 10);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

const MAX_CHAIN_IDS = 20;
/**
 * Parses and deduplicates at most 20 comma-separated safe chain IDs.
 * Throws BadRequestError for a non-string, malformed, oversized, or unsafe value.
 */
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
/**
 * Normalizes at most 256 free-text characters into the restricted RediSearch token alphabet.
 * Throws BadRequestError for a non-string or oversized value.
 */
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
/**
 * Parses and deduplicates a comma-separated document-type filter of at most 128 characters.
 * Throws BadRequestError for malformed or unsupported input.
 */
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
const MAX_SELECTOR_QUERY_LENGTH = MAX_SELECTORS * '0x00000000'.length + (MAX_SELECTORS - 1);
/**
 * Parses, lowercases, and deduplicates at most 20 comma-separated four-byte selectors.
 * Throws BadRequestError for an absent, malformed, or oversized value.
 */
export function parseSelectors(value: unknown): viem.Hex[] {
  if (typeof value !== 'string' || !value) throw new BadRequestError('Query selector not specified');
  const selectors = value.split(',');
  if (
    value.length > MAX_SELECTOR_QUERY_LENGTH ||
    selectors.length > MAX_SELECTORS ||
    selectors.some((selector) => !selectorRegex.test(selector))
  ) {
    throw new BadRequestError(`q must contain at most ${MAX_SELECTORS} valid 4-byte selectors`);
  }
  return [...new Set(selectors.map((selector) => selector.toLowerCase()))] as viem.Hex[];
}

/** Parses function/error or undefined; throws BadRequestError for any other selector kind. */
export function parseSelectorType(value: unknown): 'function' | 'error' | undefined {
  if (value === undefined) return undefined;
  if (value === 'function' || value === 'error') return value;
  throw new BadRequestError('type must be function or error');
}

/** Parses comma-separated publisher addresses; throws ServerError for malformed configured values. */
export function parseAddresses(addresses: any) {
  if (typeof addresses !== 'string') return [] as viem.Address[];
  const result = addresses.split(',');

  if (result.some((val) => !viem.isAddress(val))) {
    throw new ServerError(`Invalid publishers "${addresses}"`);
  }

  return result as viem.Address[];
}

/** Returns whether a mutable Redis tag resolves to the supplied immutable package record. */
export function isRedisTagOfPackage(a: RedisPackage, b: RedisTag) {
  return a.name === b.name && a.version === b.versionOfTag && a.preset === b.preset && a.chainId === b.chainId;
}
