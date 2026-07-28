import { ErrorRequestHandler } from 'express';
import { errorIdentity } from './logging';

export class ServerError extends Error {
  status: number;

  constructor(message = 'Server Error', status = 500) {
    super(message);
    this.status = status;
  }
}

export class ServiceUnavailableError extends ServerError {
  constructor(message = 'Server Unavailable', status = 503) {
    super(message);
    this.status = status;
  }
}

export class BadRequestError extends ServerError {
  constructor(message = 'Bad Request', status = 400) {
    super(message);
    this.status = status;
  }
}

export class ForbiddenError extends ServerError {
  constructor(message = 'Forbidden', status = 403) {
    super(message);
    this.status = status;
  }
}

export class NotFoundError extends ServerError {
  constructor(message = 'Not Found', status = 404) {
    super(message);
    this.status = status;
  }
}

export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const error = err instanceof ServerError ? err : new ServerError();

  if (!(error instanceof ServiceUnavailableError) && error.status >= 500) {
    // eslint-disable-next-line no-console
    console.error('query API request failed', {
      ...errorIdentity(err),
      status: error.status,
    });
  }

  res.status(error.status);
  res.json({
    status: error.status,
    error: error.status >= 500 ? (error.status === 503 ? 'Service Unavailable' : 'Internal Server Error') : error.message,
  });
};
