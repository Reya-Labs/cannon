import { Server } from 'node:http';
import cors from 'cors';
import express, { Express } from 'express';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import * as routes from './routes';

import type { RepoContext } from './types';

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

  app.use(morgan('short'));
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
