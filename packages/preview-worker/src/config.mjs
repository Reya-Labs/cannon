const HEADER_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

export const REYA_CHAIN_ID = 1729;
export const OP_CHAIN_ID = 10;

/**
 * `disabled` remains first and remains the default. Activating `fork` is an
 * explicit deployment decision: it additionally requires the Ethereum Mainnet
 * registry endpoint, the Cannon engine in the image and the pinned Foundry
 * runtime, and each of those is checked before the worker accepts traffic.
 */
export const SIMULATOR_MODES = Object.freeze(['disabled', 'fork']);

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(value, key, maximum) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${key} is outside the supported range`);
  }
  return parsed;
}

// Optional values follow `required()`: an empty or whitespace-only variable —
// including a secret file read with its trailing newline — counts as absent and
// falls back, rather than failing validation with a misleading message.
function header(value, fallback, key) {
  const parsed = (value?.trim() || fallback).toLowerCase();
  if (!HEADER_PATTERN.test(parsed)) {
    throw new Error(`${key} is not a valid HTTP header name`);
  }
  return parsed;
}

/**
 * The browser origin is the only value the worker ever reflects. It must be one
 * canonical HTTPS origin so a wildcard, a port, a path or a second origin can
 * never widen CORS.
 */
function uiOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('PREVIEW_UI_ORIGIN must be one canonical HTTPS origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.origin
  ) {
    throw new Error('PREVIEW_UI_ORIGIN must be one canonical HTTPS origin');
  }
  return parsed.origin;
}

/**
 * Upstream credentials never reach the browser, so the URL may carry a token
 * path. It must still be one canonical, credential-free, redirect-free HTTPS
 * URL: no userinfo, no query, no fragment.
 */
function upstreamUrl(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be one canonical HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.href
  ) {
    throw new Error(`${key} must be one canonical HTTPS URL`);
  }
  return parsed.href;
}

/**
 * Cluster-internal upstreams are addressed over plain HTTP inside the mesh, so
 * they are constrained to an exact origin with no path, query or credentials.
 */
function internalOrigin(value, key) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be one canonical internal origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.origin
  ) {
    throw new Error(`${key} must be one canonical internal origin`);
  }
  return parsed.origin;
}

function safeAddress(value) {
  if (!ADDRESS_PATTERN.test(value) || value === ZERO_ADDRESS) {
    throw new Error(
      'PREVIEW_SAFE_ADDRESS must be one non-zero lowercase EVM address',
    );
  }
  return value;
}

export function loadConfig(env = process.env) {
  const proxySecret = required(env, 'AUTH_PROXY_SECRET');
  if (Buffer.byteLength(proxySecret, 'utf8') < 32) {
    throw new Error('AUTH_PROXY_SECRET must contain at least 32 bytes');
  }
  const identityHeader = header(
    env.AUTH_IDENTITY_HEADER,
    'x-reya-user',
    'AUTH_IDENTITY_HEADER',
  );
  const proxySecretHeader = header(
    env.AUTH_PROXY_SECRET_HEADER,
    'x-reya-proxy-secret',
    'AUTH_PROXY_SECRET_HEADER',
  );
  const rolesHeader = header(
    env.AUTH_ROLES_HEADER,
    'x-reya-roles',
    'AUTH_ROLES_HEADER',
  );
  if (new Set([identityHeader, proxySecretHeader, rolesHeader]).size !== 3) {
    throw new Error('authentication header names must be distinct');
  }

  const defaultCommit = required(env, 'PREVIEW_SOURCE_COMMIT');
  if (!COMMIT_PATTERN.test(defaultCommit)) {
    throw new Error(
      'PREVIEW_SOURCE_COMMIT must be a lowercase full Git commit SHA',
    );
  }
  const defaultPreviousPackageCid = required(
    env,
    'PREVIEW_PREVIOUS_PACKAGE_CID',
  );
  if (!CID_PATTERN.test(defaultPreviousPackageCid)) {
    throw new Error('PREVIEW_PREVIOUS_PACKAGE_CID must be one CIDv0');
  }

  const simulatorMode = env.PREVIEW_SIMULATOR_MODE?.trim() || 'disabled';
  if (!SIMULATOR_MODES.includes(simulatorMode)) {
    throw new Error(
      `PREVIEW_SIMULATOR_MODE must be one of: ${SIMULATOR_MODES.join(', ')}`,
    );
  }
  // Cannon resolves package references against OP Mainnet and then Ethereum
  // Mainnet. A worker that could only read one of them would silently resolve
  // a different package set than `cannon build` does, so the second endpoint
  // is required exactly when a build can actually run.
  const mainnetRpcUrl =
    simulatorMode === 'disabled'
      ? null
      : upstreamUrl(
          required(env, 'PREVIEW_MAINNET_RPC_URL'),
          'PREVIEW_MAINNET_RPC_URL',
        );

  return Object.freeze({
    artifactOrigin: internalOrigin(
      required(env, 'PREVIEW_ARTIFACT_ORIGIN'),
      'PREVIEW_ARTIFACT_ORIGIN',
    ),
    auth: Object.freeze({
      identityHeader,
      proxySecret,
      proxySecretHeader,
      rolesHeader,
    }),
    chainId: REYA_CHAIN_ID,
    defaultCommit,
    defaultPreviousPackageCid,
    mainnetRpcUrl,
    opRpcUrl: upstreamUrl(
      required(env, 'PREVIEW_OP_RPC_URL'),
      'PREVIEW_OP_RPC_URL',
    ),
    port: positiveInteger(env.PORT?.trim() || '8080', 'PORT', 65_535),
    rpcUrl: upstreamUrl(required(env, 'PREVIEW_RPC_URL'), 'PREVIEW_RPC_URL'),
    safeAddress: safeAddress(required(env, 'PREVIEW_SAFE_ADDRESS')),
    simulatorMode,
    sourceOrigin: internalOrigin(
      required(env, 'PREVIEW_SOURCE_ORIGIN'),
      'PREVIEW_SOURCE_ORIGIN',
    ),
    uiOrigin: uiOrigin(required(env, 'PREVIEW_UI_ORIGIN')),
  });
}

/**
 * Redacts a loaded configuration for start-up logging. Upstream URLs may embed
 * credentials, so only their presence is ever reported.
 */
export function describeConfig(config) {
  return Object.freeze({
    artifactOrigin: config.artifactOrigin,
    chainId: config.chainId,
    defaultCommit: config.defaultCommit,
    defaultPreviousPackageCid: config.defaultPreviousPackageCid,
    mainnetRpcConfigured: (config.mainnetRpcUrl ?? '').length > 0,
    opRpcConfigured: config.opRpcUrl.length > 0,
    port: config.port,
    rpcConfigured: config.rpcUrl.length > 0,
    safeAddress: config.safeAddress,
    simulatorMode: config.simulatorMode,
    sourceOrigin: config.sourceOrigin,
    uiOrigin: config.uiOrigin,
  });
}
