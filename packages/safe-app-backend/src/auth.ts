import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';
import type { Actor, ActorRole } from './types';
import type { AppConfig } from './config';

const knownRoles = new Set<ActorRole>(['operator', 'proposer', 'signer']);

function secureEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function readSingleHeader(req: Request, header: string): string {
  const value = req.get(header)?.trim();
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new HttpError(401, 'unauthenticated', `missing or invalid ${header} header`);
  }
  return value;
}

export function proxyAuthenticator(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const suppliedSecret = readSingleHeader(req, config.auth.proxySecretHeader);
      if (!secureEqual(suppliedSecret, config.auth.proxySecret)) {
        throw new HttpError(401, 'unauthenticated', 'request did not come through the trusted identity proxy');
      }

      const subject = readSingleHeader(req, config.auth.identityHeader);
      if (subject.length > 320) throw new HttpError(401, 'unauthenticated', 'identity is too long');

      const roleValues = readSingleHeader(req, config.auth.rolesHeader)
        .split(',')
        .map((role) => role.trim().toLowerCase())
        .filter(Boolean);
      const roles = new Set<ActorRole>();
      for (const role of roleValues) {
        if (!knownRoles.has(role as ActorRole)) {
          throw new HttpError(403, 'invalid_role', `unsupported application role "${role}"`);
        }
        roles.add(role as ActorRole);
      }
      if (roles.size === 0) throw new HttpError(403, 'forbidden', 'no application role was supplied');

      const actor: Actor = { subject, roles };
      res.locals.actor = actor;
      (req as Request & { actor?: Actor }).actor = actor;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAnyRole(actor: Actor, ...required: ActorRole[]): void {
  if (!required.some((role) => actor.roles.has(role))) {
    throw new HttpError(403, 'forbidden', `requires one of: ${required.join(', ')}`);
  }
}

export function getActor(req: Request): Actor {
  const actor = (req as Request & { actor?: Actor }).actor;
  if (!actor) throw new HttpError(401, 'unauthenticated', 'actor identity is unavailable');
  return actor;
}
