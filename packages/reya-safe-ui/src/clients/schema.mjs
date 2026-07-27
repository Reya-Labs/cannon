import { REYA_CHAIN_ID } from './config.mjs';
import { fail } from './errors.mjs';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUES = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index])
);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CONTRACT_NAME_PATTERN = /^[A-Z][A-Za-z0-9_]{0,127}$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]$/;
const PACKAGE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;
const PACKAGE_PRESET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/;
const SELECTOR_PATTERN = /^0x[0-9a-f]{8}$/;
const MAX_RESPONSE_TOTAL = 1_000_000;
const MAX_SEARCH_RESULTS = 500;
const MAX_PACKAGE_RESULTS = 500;
const MAX_SELECTOR_RESULTS = 10;
const MAX_ABI_FIXED_ARRAY_LENGTH = 0xffff_ffff;
const DOCUMENT_TYPES = new Set([
  'contract',
  'error',
  'function',
  'namespace',
  'package',
]);
const SELECTOR_TYPES = new Set(['error', 'function']);

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

function reject() {
  fail('RESPONSE_REJECTED');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value) {
  if (!isPlainObject(value)) reject();
  return value;
}

function assertExactKeys(value, required, optional = []) {
  const record = assertObject(value);
  const actual = Reflect.ownKeys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    actual.some(
      (key) =>
        typeof key !== 'string' ||
        (!required.includes(key) && !optional.includes(key))
    )
  ) {
    reject();
  }
  return record;
}

function assertString(value, maximum, pattern) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    reject();
  }
  return value;
}

function assertNonNegativeInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    reject();
  }
  return value;
}

function assertChainId(value) {
  if (value !== REYA_CHAIN_ID) reject();
  return value;
}

function assertIndexedChainId(value) {
  if (!Number.isSafeInteger(value) || value < 1) reject();
  return value;
}

function assertAddress(value) {
  return assertString(value, 42, ADDRESS_PATTERN);
}

function decodeBase58(value) {
  const bytes = [0];

  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return undefined;

    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (
    let index = 0;
    index < value.length - 1 && value[index] === '1';
    index += 1
  ) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function isCanonicalCidV0(value) {
  if (
    typeof value !== 'string' ||
    value.length !== 46 ||
    !value.startsWith('Qm')
  ) {
    return false;
  }

  const decoded = decodeBase58(value);
  return (
    decoded?.byteLength === 34 && decoded[0] === 0x12 && decoded[1] === 0x20
  );
}

function assertIpfsUrl(value, allowEmpty = false) {
  if (allowEmpty && value === '') return value;
  if (
    typeof value !== 'string' ||
    !value.startsWith('ipfs://') ||
    !isCanonicalCidV0(value.slice('ipfs://'.length))
  ) {
    reject();
  }
  return value;
}

function assertPackageName(value) {
  return assertString(value, 31, PACKAGE_NAME_PATTERN);
}

function assertPackageVersion(value) {
  return assertString(value, 32, PACKAGE_VERSION_PATTERN);
}

function assertPackagePreset(value) {
  return assertString(value, 24, PACKAGE_PRESET_PATTERN);
}

function isCanonicalPartialPackageRef(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const match =
    /^(?<name>[a-z0-9][A-Za-z0-9-]{1,29}[a-z0-9]):(?<version>[^@]+)(?:@(?<preset>[^\s]+))?$/.exec(
      value
    );
  return Boolean(
    match?.groups &&
      (match.groups.name === 'ipfs' || match.groups.version.length <= 32) &&
      (match.groups.preset === undefined || match.groups.preset.length <= 24)
  );
}

function isCanonicalAbiBaseType(value) {
  if (
    value === 'address' ||
    value === 'bool' ||
    value === 'bytes' ||
    value === 'function' ||
    value === 'string'
  ) {
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
    return (
      String(size) === integer.groups.size &&
      size >= 8 &&
      size <= 256 &&
      size % 8 === 0
    );
  }

  return false;
}

export function isCanonicalAbiSignature(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    return false;
  }

  let offset = 0;
  const isIdentifierStart = (character) =>
    typeof character === 'string' && /[A-Za-z_$]/.test(character);
  const isIdentifierPart = (character) =>
    typeof character === 'string' && /[A-Za-z0-9_$]/.test(character);

  const parseParameterList = (allowEmpty) => {
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
  };

  const parseType = () => {
    if (value[offset] === '(') {
      if (!parseParameterList(false)) return false;
    } else {
      const start = offset;
      while (
        offset < value.length &&
        /[A-Za-z0-9]/.test(value[offset])
      ) {
        offset += 1;
      }
      if (
        offset === start ||
        !isCanonicalAbiBaseType(value.slice(start, offset))
      ) {
        return false;
      }
    }

    while (value[offset] === '[') {
      offset += 1;
      const start = offset;
      while (/[0-9]/.test(value[offset] ?? '')) offset += 1;
      const length = value.slice(start, offset);
      if (
        length &&
        (!/^[1-9][0-9]*$/.test(length) ||
          length.length > 10 ||
          Number(length) > MAX_ABI_FIXED_ARRAY_LENGTH)
      ) {
        return false;
      }
      if (value[offset] !== ']') return false;
      offset += 1;
    }
    return true;
  };

  if (!isIdentifierStart(value[offset])) return false;
  offset += 1;
  while (isIdentifierPart(value[offset])) offset += 1;
  return parseParameterList(true) && offset === value.length;
}

function assertPackage(document) {
  const value = assertExactKeys(
    document,
    [
      'chainId',
      'deployUrl',
      'metaUrl',
      'name',
      'preset',
      'publisher',
      'timestamp',
      'type',
      'version',
    ],
    ['miscUrl']
  );
  if (value.type !== 'package') reject();
  assertPackageName(value.name);
  assertPackageVersion(value.version);
  assertPackagePreset(value.preset);
  assertChainId(value.chainId);
  assertIpfsUrl(value.deployUrl);
  assertIpfsUrl(value.metaUrl, true);
  if (Object.hasOwn(value, 'miscUrl')) assertIpfsUrl(value.miscUrl);
  assertNonNegativeInteger(value.timestamp);
  assertAddress(value.publisher);
  return value;
}

function assertNamespace(document) {
  const value = assertExactKeys(document, ['count', 'name', 'type']);
  if (value.type !== 'namespace') reject();
  assertPackageName(value.name);
  assertNonNegativeInteger(value.count, MAX_RESPONSE_TOTAL);
  return value;
}

function assertContract(document) {
  const value = assertExactKeys(document, [
    'address',
    'chainId',
    'name',
    'packageName',
    'preset',
    'type',
    'version',
  ]);
  if (value.type !== 'contract') reject();
  assertString(value.name, 128, CONTRACT_NAME_PATTERN);
  assertAddress(value.address);
  assertChainId(value.chainId);
  assertPackageName(value.packageName);
  assertPackagePreset(value.preset);
  assertPackageVersion(value.version);
  return value;
}

async function assertSelector(document, verifyAbiSelector) {
  const optional = [
    'address',
    'chainId',
    'contractName',
    'packageName',
    'preset',
    'version',
  ];
  const value = assertExactKeys(
    document,
    ['name', 'selector', 'type'],
    optional
  );
  if (!SELECTOR_TYPES.has(value.type)) reject();
  if (!isCanonicalAbiSignature(value.name)) reject();
  assertString(value.selector, 10, SELECTOR_PATTERN);

  if (Object.hasOwn(value, 'address')) assertAddress(value.address);
  if (Object.hasOwn(value, 'chainId')) assertChainId(value.chainId);
  if (Object.hasOwn(value, 'contractName')) {
    assertString(value.contractName, 128, CONTRACT_NAME_PATTERN);
  }

  const packageFields = ['packageName', 'preset', 'version'];
  const packageFieldCount = packageFields.filter((key) =>
    Object.hasOwn(value, key)
  ).length;
  if (packageFieldCount !== 0 && packageFieldCount !== packageFields.length) {
    reject();
  }
  if (packageFieldCount === packageFields.length) {
    assertPackageName(value.packageName);
    assertPackagePreset(value.preset);
    assertPackageVersion(value.version);
    if (
      !Object.hasOwn(value, 'address') ||
      !Object.hasOwn(value, 'chainId') ||
      !Object.hasOwn(value, 'contractName')
    ) {
      reject();
    }
  } else if (
    ['address', 'chainId', 'contractName'].some((key) =>
      Object.hasOwn(value, key)
    )
  ) {
    reject();
  }

  let verified;
  try {
    verified = await verifyAbiSelector(value.name, value.selector);
  } catch {
    reject();
  }
  if (verified !== true) reject();
  return value;
}

async function assertDocument(document, verifyAbiSelector) {
  const value = assertObject(document);
  if (!DOCUMENT_TYPES.has(value.type)) reject();
  switch (value.type) {
    case 'contract':
      return assertContract(value);
    case 'namespace':
      return assertNamespace(value);
    case 'package':
      return assertPackage(value);
    case 'error':
    case 'function':
      return assertSelector(value, verifyAbiSelector);
    default:
      reject();
  }
}

function assertArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) reject();
  return value;
}

function assertStatus(value) {
  if (value !== 200) reject();
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export function validateChainsResponse(response) {
  const value = assertExactKeys(response, ['data', 'status', 'total']);
  assertStatus(value.status);
  assertNonNegativeInteger(value.total, MAX_RESPONSE_TOTAL);
  const data = assertArray(value.data, 50);
  data.forEach(assertIndexedChainId);
  if (
    new Set(data).size !== data.length ||
    value.total < data.length ||
    !data.includes(REYA_CHAIN_ID)
  ) {
    reject();
  }
  return deepFreeze({
    data: [REYA_CHAIN_ID],
    status: 200,
    total: 1,
  });
}

export function validatePackagesResponse(response, expectedPackageName) {
  const value = assertExactKeys(response, ['data', 'status', 'total']);
  assertStatus(value.status);
  assertNonNegativeInteger(value.total, MAX_RESPONSE_TOTAL);
  const data = assertArray(value.data, MAX_PACKAGE_RESULTS);
  for (const document of data) {
    const pkg = assertPackage(document);
    if (pkg.name !== expectedPackageName) reject();
  }
  if (value.total < data.length) reject();
  return deepFreeze(value);
}

export function validatePackageResponse(response, expectedPackage) {
  const value = assertExactKeys(response, ['data', 'status']);
  assertStatus(value.status);
  const pkg = assertPackage(value.data);
  if (
    pkg.name !== expectedPackage.name ||
    pkg.version !== expectedPackage.version ||
    pkg.preset !== expectedPackage.preset
  ) {
    reject();
  }
  return deepFreeze(value);
}

export async function validateSearchResponse(
  response,
  expectedQuery,
  expectedTypes,
  rawQuery,
  verifyAbiSelector
) {
  const value = assertExactKeys(response, [
    'data',
    'isAddress',
    'isContractName',
    'isFunctionSelector',
    'isHex',
    'isPackageRef',
    'isTx',
    'query',
    'status',
    'total',
  ]);
  assertStatus(value.status);
  assertString(value.query, 256);
  if (value.query !== expectedQuery) reject();
  for (const key of [
    'isAddress',
    'isContractName',
    'isFunctionSelector',
    'isHex',
    'isPackageRef',
    'isTx',
  ]) {
    if (typeof value[key] !== 'boolean') reject();
  }
  const isTx = /^0x[0-9a-f]{64}$/.test(rawQuery);
  const expectedFlags = {
    isAddress: /^0x[0-9a-f]{40}$/.test(rawQuery),
    isContractName: /^[A-Z][A-Za-z0-9_]*$/.test(rawQuery),
    isFunctionSelector: /^0x[0-9a-f]{8}$/.test(rawQuery),
    isHex: !isTx && /^0x[0-9a-f]*$/.test(rawQuery),
    isPackageRef: isCanonicalPartialPackageRef(rawQuery),
    isTx,
  };
  for (const [key, expected] of Object.entries(expectedFlags)) {
    if (value[key] !== expected) reject();
  }
  assertNonNegativeInteger(value.total, MAX_RESPONSE_TOTAL);
  const data = assertArray(value.data, MAX_SEARCH_RESULTS);
  for (const document of data) {
    const validated = await assertDocument(document, verifyAbiSelector);
    if (expectedTypes.length > 0 && !expectedTypes.includes(validated.type)) {
      reject();
    }
  }
  if (value.total < data.length) reject();
  return deepFreeze(value);
}

export async function validateSelectorResponse(
  response,
  requestedSelectors,
  requestedType,
  verifyAbiSelector
) {
  const value = assertExactKeys(response, ['results', 'status']);
  assertStatus(value.status);
  const results = assertObject(value.results);
  const keys = Object.keys(results).sort();
  const expected = [...requestedSelectors].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) reject();

  for (const selector of expected) {
    const entries = assertArray(results[selector], MAX_SELECTOR_RESULTS);
    for (const entry of entries) {
      const validated = await assertSelector(entry, verifyAbiSelector);
      if (
        validated.selector !== selector ||
        (requestedType !== undefined && validated.type !== requestedType)
      ) {
        reject();
      }
    }
  }
  return deepFreeze(value);
}

export function validateSearchInput(input) {
  const value = assertInputObject(input, ['query'], ['types']);
  const normalized =
    typeof value.query === 'string'
      ? value.query
          .trim()
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/^[-_]+|[^a-z0-9-_]|[-_]+$/g, '')
      : '';
  const isHexCandidate =
    typeof value.query === 'string' && /^0x[0-9a-fA-F]*$/.test(value.query);
  if (
    typeof value.query !== 'string' ||
    value.query.length === 0 ||
    value.query.length > 256 ||
    value.query !== value.query.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.query) ||
    normalized.length === 0 ||
    (isHexCandidate && value.query !== value.query.toLowerCase())
  ) {
    fail('INVALID_INPUT');
  }

  let types = [];
  if (Object.hasOwn(value, 'types')) {
    if (
      !Array.isArray(value.types) ||
      value.types.length === 0 ||
      value.types.length > DOCUMENT_TYPES.size ||
      value.types.some(
        (type) => typeof type !== 'string' || !DOCUMENT_TYPES.has(type)
      ) ||
      new Set(value.types).size !== value.types.length
    ) {
      fail('INVALID_INPUT');
    }
    types = [...value.types];
  }
  return Object.freeze({
    normalizedQuery: normalized,
    query: value.query,
    types: Object.freeze(types),
  });
}

function assertInputObject(input, required, optional = []) {
  if (!isPlainObject(input)) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(input);
  if (
    required.some((key) => !Object.hasOwn(input, key)) ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (!required.includes(key) && !optional.includes(key))
    )
  ) {
    fail('INVALID_INPUT');
  }
  return input;
}

export function validatePackageNameInput(input) {
  const value = assertInputObject(input, ['packageName']);
  if (
    typeof value.packageName !== 'string' ||
    !PACKAGE_NAME_PATTERN.test(value.packageName)
  ) {
    fail('INVALID_INPUT');
  }
  return value.packageName;
}

export function validatePackageRefInput(input) {
  const value = assertInputObject(input, ['fullPackageRef']);
  if (
    typeof value.fullPackageRef !== 'string' ||
    value.fullPackageRef.length > 89
  ) {
    fail('INVALID_INPUT');
  }

  const match = /^(?<name>[^:]+):(?<version>[^@]+)@(?<preset>.+)$/.exec(
    value.fullPackageRef
  );
  if (
    !match?.groups ||
    !PACKAGE_NAME_PATTERN.test(match.groups.name) ||
    !PACKAGE_VERSION_PATTERN.test(match.groups.version) ||
    !PACKAGE_PRESET_PATTERN.test(match.groups.preset)
  ) {
    fail('INVALID_INPUT');
  }
  return Object.freeze({
    fullPackageRef: value.fullPackageRef,
    name: match.groups.name,
    preset: match.groups.preset,
    version: match.groups.version,
  });
}

export function validateSelectorInput(input) {
  const value = assertInputObject(input, ['selectors'], ['type']);
  if (
    !Array.isArray(value.selectors) ||
    value.selectors.length === 0 ||
    value.selectors.length > 20 ||
    value.selectors.some(
      (selector) =>
        typeof selector !== 'string' || !SELECTOR_PATTERN.test(selector)
    ) ||
    new Set(value.selectors).size !== value.selectors.length
  ) {
    fail('INVALID_INPUT');
  }
  if (Object.hasOwn(value, 'type') && !SELECTOR_TYPES.has(value.type)) {
    fail('INVALID_INPUT');
  }
  return Object.freeze({
    selectors: Object.freeze([...value.selectors]),
    type: value.type,
  });
}

export function validateCidInput(input) {
  const value = assertInputObject(input, ['cid']);
  if (!isCanonicalCidV0(value.cid)) fail('INVALID_INPUT');
  return value.cid;
}
