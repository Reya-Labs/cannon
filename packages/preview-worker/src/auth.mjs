import { timingSafeEqual } from 'node:crypto';
import { PreviewError } from './errors.mjs';

const HEADER_VALUE_PATTERN = /^[\x20-\x7e]{1,320}$/;
const KNOWN_ROLES = Object.freeze(['operator', 'proposer', 'signer']);

/**
 * Reads exactly one occurrence of a trusted header.
 *
 * The identity proxy strips every client-supplied copy of these headers before
 * adding its own, so a request that still carries two copies is either a proxy
 * misconfiguration or a smuggling attempt. Both fail closed. `rawHeaders` is
 * used because `headers[name]` silently comma-joins duplicates, which would let
 * a spoofed value ride alongside the trusted one.
 */
export function exactlyOneHeader(request, name) {
  const raw = request.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0) {
    throw new PreviewError(401, 'UNAUTHENTICATED');
  }
  let found;
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index].toLowerCase() !== name) continue;
    count += 1;
    found = raw[index + 1];
  }
  if (
    count !== 1 ||
    typeof found !== 'string' ||
    !HEADER_VALUE_PATTERN.test(found)
  ) {
    throw new PreviewError(401, 'UNAUTHENTICATED');
  }
  return found;
}

function equalSecret(actual, expected) {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

/**
 * Authenticates one request that arrived through the Tailscale identity proxy
 * and returns the bounded actor. The worker never authenticates a browser
 * directly and holds no session, cookie or bearer path.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {ReturnType<import('./config.mjs').loadConfig>} config
 * @returns {Readonly<{roles: readonly string[], subject: string}>}
 */
export function authenticate(request, config) {
  const secret = exactlyOneHeader(request, config.auth.proxySecretHeader);
  if (!equalSecret(secret, config.auth.proxySecret)) {
    throw new PreviewError(401, 'UNAUTHENTICATED');
  }
  const subject = exactlyOneHeader(request, config.auth.identityHeader).trim();
  if (subject.length < 1 || subject.length > 320) {
    throw new PreviewError(401, 'UNAUTHENTICATED');
  }
  const roles = exactlyOneHeader(request, config.auth.rolesHeader)
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  if (roles.length < 1 || roles.some((role) => !KNOWN_ROLES.includes(role))) {
    throw new PreviewError(403, 'FORBIDDEN');
  }
  return Object.freeze({
    roles: Object.freeze([...new Set(roles)].sort()),
    subject,
  });
}

/**
 * The preview and registry routes are read-only derivations, so any recognised
 * Cannon role may call them. There is deliberately no role that unlocks an
 * execution path, because the worker exposes none.
 */
export function requireAnyRole(actor, ...allowed) {
  if (!allowed.some((role) => actor.roles.includes(role))) {
    throw new PreviewError(403, 'FORBIDDEN');
  }
}
