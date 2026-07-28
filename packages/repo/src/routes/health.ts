import { Response, Router } from 'express';
import packageJson from '../../package.json';
import { HealthContext, RepoRequest } from '../types';
import { validateBearerToken } from '../helpers/validateBearerToken';

export function health(ctx: HealthContext) {
  const app: Router = Router();

  async function respondWithHealth(res: Response, dependencies: Array<Promise<unknown> | undefined>) {
    try {
      await Promise.all(dependencies);
      res.json({
        status: 'ok',
        version: packageJson.version,
      });
    } catch {
      // Backend errors may include object-store endpoints, bucket names, or
      // credentials. Keep both the response and server log payload-free.
      console.error('repository dependency health check failed');
      res.status(503).json({ status: 'error', message: 'Repository dependency check failed' });
    }
  }

  app.get('/health', async (_, res) => {
    await respondWithHealth(res, [ctx.rdb?.ping(), ctx.objectStoreRead?.healthCheck(), ctx.objectStoreWrite?.healthCheck()]);
  });

  if (ctx.rdb && ctx.objectStoreWrite) {
    app.get(
      '/health/write',
      (req, res, next) => validateBearerToken(req as RepoRequest, res, next, ctx),
      async (_, res) => {
        await respondWithHealth(res, [ctx.rdb?.ping(), ctx.objectStoreWrite?.healthCheck()]);
      }
    );
  }

  return app;
}
