const ERROR_MESSAGES = Object.freeze({
  ARTIFACT_MISMATCH: 'Artifact integrity verification failed.',
  INVALID_CONFIGURATION: 'Read client configuration is invalid.',
  INVALID_INPUT: 'Read client input is invalid.',
  REQUEST_FAILED: 'The Reya read service request failed.',
  REQUEST_TIMEOUT: 'The Reya read service request timed out.',
  RESPONSE_REJECTED: 'The Reya read service response was rejected.',
  SERVICE_REJECTED: 'The Reya staging service rejected the request.',
  SIGNATURE_REJECTED: 'The Safe owner signature was rejected.',
  SIGNING_IN_PROGRESS: 'A Safe owner signing request is already in progress.',
  WALLET_REQUEST_FAILED: 'The Safe owner wallet request failed.',
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

export class ReyaStagingServiceError extends ReyaReadClientError {
  constructor(httpStatus, serviceCode) {
    super('SERVICE_REJECTED');
    this.name = 'ReyaStagingServiceError';
    this.httpStatus = httpStatus;
    this.serviceCode = serviceCode;
  }
}

export function fail(code) {
  throw new ReyaReadClientError(code);
}

export function failStagingService(httpStatus, serviceCode) {
  throw new ReyaStagingServiceError(httpStatus, serviceCode);
}
