import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { proxyAuthenticator } from '../src/auth';
import type { AppConfig } from '../src/config';

const config = {
  auth: {
    identityHeader: 'x-reya-user',
    proxySecret: 'x'.repeat(32),
    proxySecretHeader: 'x-reya-proxy-secret',
  },
} as AppConfig;

function authenticate(headers: Record<string, string>): { actor: unknown; error: unknown } {
  const req = { headers } as unknown as Request;
  const res = { locals: {} } as Response;
  let error: unknown;
  const next = ((value?: unknown) => {
    error = value;
  }) as NextFunction;

  proxyAuthenticator(config)(req, res, next);
  return { actor: res.locals.actor, error };
}

describe('proxyAuthenticator', () => {
  it('accepts an identity at the 320-character boundary', () => {
    const identity = 'i'.repeat(320);
    const result = authenticate({
      'x-reya-proxy-secret': config.auth.proxySecret,
      'x-reya-user': identity,
    });

    expect(result).toEqual({ actor: identity, error: undefined });
  });

  it('rejects an identity beyond the 320-character boundary', () => {
    const result = authenticate({
      'x-reya-proxy-secret': config.auth.proxySecret,
      'x-reya-user': 'i'.repeat(321),
    });

    expect(result.error).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(result.actor).toBeUndefined();
  });

  it.each([
    ['x-reya-user', 'alice\nadmin'],
    ['x-reya-user', 'alice\radmin'],
    ['x-reya-proxy-secret', `${'x'.repeat(32)}\n`],
    ['x-reya-proxy-secret', `${'x'.repeat(32)}\r`],
  ])('rejects CR/LF injection in %s', (header, value) => {
    const result = authenticate({
      'x-reya-proxy-secret': config.auth.proxySecret,
      'x-reya-user': 'alice',
      [header]: value,
    });

    expect(result.error).toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(result.actor).toBeUndefined();
  });
});
