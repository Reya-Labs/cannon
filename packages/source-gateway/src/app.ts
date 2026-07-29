import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { proxyAuthenticator } from './auth';
import type { AppConfig } from './config';
import { HttpError, isHttpError } from './errors';
import { SourceBundleService } from './source';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const appVersion = process.env.BUILD_REVISION ?? 'unknown';

function rejectRequestBody(req: Request): void {
  const length = req.get('content-length');
  if ((length !== undefined && length !== '0') || req.get('transfer-encoding') !== undefined) {
    throw new HttpError(400, 'request_body_forbidden', 'source requests must not contain a body');
  }
}

export function createApp(config: AppConfig, source: SourceBundleService): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    })
  );
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.once('finish', () => {
      console.info(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          method: req.method,
          path: req.path,
          status: res.statusCode,
        })
      );
    });
    next();
  });
  app.use((req, res, next) => {
    const requestOrigin = req.get('origin');
    if (requestOrigin) {
      if (requestOrigin !== config.uiOrigin) {
        return next(new HttpError(403, 'origin_forbidden', 'request origin is not allowed'));
      }
      res.setHeader('Access-Control-Allow-Origin', config.uiOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'If-None-Match,X-Request-Id');
    if (req.method === 'OPTIONS') {
      if (requestOrigin !== config.uiOrigin) {
        return next(new HttpError(403, 'origin_forbidden', 'request origin is not allowed'));
      }
      return res.status(204).end();
    }
    next();
  });

  app.get('/livez', (_req, res) => res.json({ status: 'ok', version: appVersion }));
  app.get('/readyz', (_req, res) => res.json({ status: 'ok', version: appVersion }));
  app.use((req, _res, next) => {
    if (req.get('origin') !== config.uiOrigin) {
      return next(new HttpError(403, 'origin_forbidden', 'request origin is required'));
    }
    next();
  });
  app.use(proxyAuthenticator(config));
  app.use(
    rateLimit({
      keyGenerator: (_req, res) => String(res.locals.actor ?? 'unknown'),
      legacyHeaders: false,
      limit: config.rateLimit.limit,
      message: { error: { code: 'rate_limited', message: 'too many requests' } },
      passOnStoreError: false,
      standardHeaders: 'draft-7',
      validate: false,
      windowMs: config.rateLimit.windowMs,
    })
  );

  app.get('/source/reya-deployments/:commit/reya-network', async (req, res, next) => {
    try {
      rejectRequestBody(req);
      if (req.originalUrl.includes('?')) {
        throw new HttpError(400, 'query_forbidden', 'source requests must not contain a query string');
      }
      const { commit } = req.params;
      if (!COMMIT_PATTERN.test(commit)) {
        throw new HttpError(400, 'invalid_commit', 'commit must be a lowercase full Git SHA');
      }
      const encoded = await source.get(commit);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.setHeader('ETag', encoded.etag);
      if (req.get('if-none-match') === encoded.etag) return res.status(304).end();
      res.type('application/json').send(encoded.body);
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'route not found')));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    void _next;
    if (isHttpError(error)) {
      return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    }
    console.error(
      'unexpected source gateway failure',
      typeof error === 'object' && error !== null && 'name' in error ? { name: error.name } : { name: 'unknown' }
    );
    return res.status(500).json({ error: { code: 'internal_error', message: 'unexpected source gateway error' } });
  });
  return app;
}
