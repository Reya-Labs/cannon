import { Router } from 'express';
import packageJson from '../../package.json';
import { RepoContext } from '../types';

export function health(ctx: RepoContext) {
  const app: Router = Router();

  app.get('/health', async (_, res) => {
    try {
      await Promise.all([ctx.rdb.ping(), ctx.s3.healthCheck()]);
      res.json({
        status: 'ok',
        version: packageJson.version,
      });
    } catch (err) {
      console.error('repository dependency health check failed', err);
      res.status(503).json({ status: 'error', message: 'Repository dependency check failed' });
    }
  });

  return app;
}
