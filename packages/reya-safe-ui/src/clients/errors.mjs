const ERROR_MESSAGES = Object.freeze({
  ARTIFACT_MISMATCH: 'Artifact integrity verification failed.',
  INVALID_CONFIGURATION: 'Read client configuration is invalid.',
  INVALID_INPUT: 'Read client input is invalid.',
  OP_ALIAS_UNKNOWN: 'The Cannon OP registry alias is unknown.',
  REQUEST_FAILED: 'The Reya read service request failed.',
  REQUEST_TIMEOUT: 'The Reya read service request timed out.',
  RESPONSE_REJECTED: 'The Reya read service response was rejected.',
});

export class ReyaReadClientError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERROR_MESSAGES, code)
      ? code
      : 'REQUEST_FAILED';
    super(ERROR_MESSAGES[safeCode]);
    this.name = 'ReyaReadClientError';
    this.code = safeCode;
  }
}

export function fail(code) {
  throw new ReyaReadClientError(code);
}
