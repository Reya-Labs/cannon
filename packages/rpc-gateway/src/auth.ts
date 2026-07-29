import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config';
import { HttpError } from './errors';

function singleHeader(req: Request, name: string): string {
  const value = req.headers[name];
  if (typeof value !== 'string' || !value || value.includes('\n') || value.includes('\r')) {
    throw new HttpError(401, 'unauthenticated', 'request did not come through the trusted identity proxy');
  }
  return value;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function proxyAuthenticator(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const secret = singleHeader(req, config.auth.proxySecretHeader);
      if (!equalSecret(secret, config.auth.proxySecret)) {
        throw new HttpError(401, 'unauthenticated', 'request did not come through the trusted identity proxy');
      }
      const subject = singleHeader(req, config.auth.identityHeader).trim();
      if (!subject || subject.length > 320) {
        throw new HttpError(401, 'unauthenticated', 'authenticated identity is invalid');
      }
      res.locals.actor = subject;
      next();
    } catch (error) {
      next(error);
    }
  };
}
