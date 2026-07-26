import { Router } from 'express';
import basicAuth from 'express-basic-auth';
import prometheus from 'express-prom-bundle';
import { Registry } from 'prom-client';
import type { ApiConfig } from '../config';

export function createMetricsRouter(config: ApiConfig): Router {
  const metrics = Router();
  const registry = new Registry();

  metrics.use(
    '/metrics',
    basicAuth({
      challenge: true,
      users: { [config.METRICS_USER]: config.METRICS_PASSWORD },
    })
  );

  metrics.use(
    prometheus({
      customLabels: { serviceName: 'cannon-api' },
      includeMethod: true,
      includePath: true,
      metricsPath: '/metrics',
      normalizePath: [['^/packages/.*', '/packages/#packageName']],
      promRegistry: registry,
    })
  );

  return metrics;
}
