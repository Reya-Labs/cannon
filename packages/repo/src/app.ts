import { Server } from 'node:http';
import cors from 'cors';
import express, { Express } from 'express';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import * as routes from './routes';

import type { RepoContext } from './types';

const SAFE_REQUEST_LOG_FORMAT =
  ':remote-addr - :remote-user :method :safe-path HTTP/:http-version :status :res[content-length] - :response-time ms';

morgan.token('safe-path', (req) => {
  try {
    return new URL(req.url ?? '/', 'http://repo.invalid').pathname;
  } catch {
    return '/invalid-request-path';
  }
});

export function createApp(ctx: RepoContext): { app: Express; start: () => Promise<Server> } {
  const app = express();
  const readerEnabled = ctx.config.REPO_ROLE === 'reader' || ctx.config.REPO_ROLE === 'combined';
  const writerEnabled = ctx.config.REPO_ROLE === 'writer' || ctx.config.REPO_ROLE === 'combined';
  const corsAllowedOrigins = ctx.config.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (ctx.config.NODE_ENV !== 'production') {
    app.set('json spaces', 2);
  }

  if (ctx.config.TRUST_PROXY) {
    app.enable('trust proxy');
  }

  // Query strings can contain unvalidated expected CIDs; never copy them into logs.
  app.use(morgan(SAFE_REQUEST_LOG_FORMAT));
  if (corsAllowedOrigins.length > 0) {
    app.use(
      cors({
        origin: corsAllowedOrigins,
        methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
      })
    );
  }
  app.use(helmet());

  app.get('/favicon.ico', (req, res) => res.status(204));

  app.use(
    rateLimit({
      windowMs: ctx.config.RATE_LIMIT_WINDOW,
      limit: ctx.config.RATE_LIMIT_MAX,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      validate: { trustProxy: !ctx.config.TRUST_PROXY },
    })
  );

  if (writerEnabled) {
    if (!ctx.rdb || !ctx.objectStoreWrite) {
      throw new Error('writer repository role requires Redis and write-capable object storage');
    }

    app.use(
      routes.add({
        config: ctx.config,
        rdb: ctx.rdb,
        objectStoreWrite: ctx.objectStoreWrite,
      })
    );
  }

  if (readerEnabled) {
    if (!ctx.objectStoreRead) {
      throw new Error('reader repository role requires read-capable object storage');
    }

    app.use(routes.cat({ objectStoreRead: ctx.objectStoreRead }));
  }

  app.use(
    routes.health({
      config: ctx.config,
      rdb: ctx.rdb,
      objectStoreRead: ctx.objectStoreRead,
      objectStoreWrite: ctx.objectStoreWrite,
    })
  );

  return {
    app,

    start() {
      return new Promise<Server>((resolve) => {
        const _server = app.listen(Number(ctx.config.PORT), () => {
          resolve(_server);
        });
      });
    },
  };
}
