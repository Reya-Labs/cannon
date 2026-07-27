import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import packageJson from '../package.json';
import type { ApiConfig } from './config';
import { apiErrorHandler, ForbiddenError, ServiceUnavailableError } from './errors';
import { chains, packages, search, selector } from './routes';
import { createMetricsRouter } from './routes/metrics';

type AppDependencies = {
  checkReadiness: (signal: AbortSignal) => Promise<void>;
  config: ApiConfig;
  now?: () => number;
};

async function runBoundedReadinessCheck(
  checkReadiness: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => checkReadiness(controller.signal)),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('readiness check timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApp({ checkReadiness, config, now = Date.now }: AppDependencies): Express {
  const app = express();
  let readinessAttempt: Promise<void> | undefined;
  let readinessResult: { error: unknown; expiresAt: number; ready: false } | { expiresAt: number; ready: true } | undefined;
  const getReadinessAttempt = () => {
    if (readinessResult && now() < readinessResult.expiresAt) {
      return readinessResult.ready ? Promise.resolve() : Promise.reject(readinessResult.error);
    }
    if (!readinessAttempt) {
      const attempt = runBoundedReadinessCheck(checkReadiness, config.READINESS_TIMEOUT_MS).then(
        () => {
          readinessResult = { expiresAt: now() + config.READINESS_CACHE_MS, ready: true };
        },
        (error) => {
          readinessResult = { error, expiresAt: now() + config.READINESS_CACHE_MS, ready: false };
          throw error;
        }
      );
      readinessAttempt = attempt;
      const clearAttempt = () => {
        if (readinessAttempt === attempt) readinessAttempt = undefined;
      };
      void attempt.then(clearAttempt, clearAttempt);
    }
    return readinessAttempt;
  };

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  if (config.NODE_ENV === 'development' || config.NODE_ENV === 'test') {
    app.set('json spaces', 2);
  }

  app.use(helmet());
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      if (!config.CORS_ORIGINS.has(origin)) {
        return next(new ForbiddenError('Request origin is not allowed'));
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get('/livez', (_req, res) => {
    res.json({ status: 'ok', version: packageJson.version });
  });
  app.get('/readyz', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await getReadinessAttempt();
      res.json({ status: 'ok', version: packageJson.version });
    } catch {
      next(new ServiceUnavailableError('A required dependency is not ready'));
    }
  });

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 100,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    })
  );

  app.use(createMetricsRouter(config));
  app.use(selector);
  app.use(chains);
  app.use(packages);
  app.use(search);

  app.use(apiErrorHandler);
  return app;
}
