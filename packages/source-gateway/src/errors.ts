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
