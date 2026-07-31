/**
 * Fail-closed error contract for the production preview worker.
 *
 * Every rejection the browser can observe is one of these stable codes. No
 * upstream message, stack, host name, credential or internal path is ever
 * placed on the wire.
 */
export const PREVIEW_ERROR_CODES = Object.freeze([
  'INVALID_REQUEST',
  'ORIGIN_FORBIDDEN',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'BODY_TOO_LARGE',
  'PREVIEW_BUSY',
  'PREVIEW_FAILED',
  'PREVIEW_NOT_STAGEABLE',
  'REGISTRY_UNAVAILABLE',
  'RPC_PINNED_STATE_UNAVAILABLE',
  'SAFE_STATE_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
]);

export class PreviewError extends Error {
  /**
   * @param {number} status
   * @param {(typeof PREVIEW_ERROR_CODES)[number]} code
   * @param {{cause?: unknown}} [options]
   */
  constructor(status, code, options = {}) {
    if (
      !Number.isSafeInteger(status) ||
      status < 400 ||
      status > 599 ||
      !PREVIEW_ERROR_CODES.includes(code)
    ) {
      throw new Error('preview error contract is invalid');
    }
    super(code, options);
    this.name = 'PreviewError';
    this.status = status;
    this.code = code;
  }
}

export function isPreviewError(value) {
  return (
    value instanceof PreviewError &&
    Number.isSafeInteger(value.status) &&
    PREVIEW_ERROR_CODES.includes(value.code)
  );
}

/**
 * Maps any thrown value onto the public contract. Unknown failures collapse to
 * a single opaque 502 so an upstream can never shape the browser-visible body.
 */
export function toPublicError(value) {
  if (isPreviewError(value)) return value;
  return new PreviewError(502, 'UPSTREAM_UNAVAILABLE');
}
