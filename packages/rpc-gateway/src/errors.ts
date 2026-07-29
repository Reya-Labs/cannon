export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'HttpError';
    this.status = status;
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

export class QuorumError extends Error {
  readonly category: string;

  constructor(category: string) {
    super('RPC provider quorum is unavailable');
    this.category = category;
    this.name = 'QuorumError';
  }
}
