import { type Request, Router } from 'express';
import basicAuth from 'express-basic-auth';
import prometheus from 'express-prom-bundle';
import { Registry } from 'prom-client';
import type { ApiConfig } from '../config';

function normalizeMetricPath(req: Request): string {
  return typeof req.route?.path === 'string' ? req.route.path : '/unmatched';
}

function normalizeMetricLabels(labels: Record<string, number | string>): void {
  if (typeof labels.method === 'string' && !['GET', 'HEAD', 'OPTIONS'].includes(labels.method)) {
    labels.method = 'OTHER';
  }
}

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
      normalizePath: normalizeMetricPath,
      promRegistry: registry,
      transformLabels: normalizeMetricLabels,
    })
  );

  return metrics;
}
