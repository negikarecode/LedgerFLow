import { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

/**
 * Middleware that gates demo, chaos testing, and mock receiver endpoints.
 * By default, DEMO_MODE is disabled (false) to prevent destructive or simulation
 * actions in production deployments.
 */
export function requireDemoMode(req: Request, res: Response, next: NextFunction): void {
  const isDemo = (env.DEMO_MODE || process.env.DEMO_MODE === 'true') && process.env.DEMO_MODE !== 'false';
  if (isDemo || (process.env.NODE_ENV === 'test' && process.env.TEST_BLOCK_DEMO !== 'true')) {
    return next();
  }

  res.status(403).json({
    error: 'DEMO_MODE_DISABLED',
    message:
      'Demo and chaos simulation endpoints are disabled by default. Set DEMO_MODE=true in your environment to enable them in non-production environments.',
  });
}
