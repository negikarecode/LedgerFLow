import { Request, Response } from 'express';
import { checkDbHealth } from '../../db/pool';
import { checkRedisHealth } from '../../redis/client';

/**
 * GET /health
 * Aggregated health status. Returns 200 if both PostgreSQL and Redis are UP.
 * Returns 503 if either dependency is DOWN.
 * Maintained for backward compatibility with existing probes and tests.
 */
export async function getHealth(req: Request, res: Response): Promise<void> {
  const [postgres, redis] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);

  const isHealthy = postgres.status === 'up' && redis.status === 'up';
  const statusCode = isHealthy ? 200 : 503;

  res.status(statusCode).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      postgres,
      redis,
    },
  });
}

/**
 * GET /health/live (alias /livez)
 * Liveness probe. Verifies that the API server process is alive and responsive.
 * Does NOT check external dependencies (PostgreSQL/Redis) to prevent cascading
 * restart loops during transient infrastructure outages.
 */
export async function getLiveness(req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
  });
}

/**
 * GET /health/ready (alias /readyz)
 * Readiness probe. Distinguishes required dependencies from optional accelerators:
 * - PostgreSQL is REQUIRED for transaction processing, balance mutations, and outbox durable events (returns 503 if down).
 * - Redis is an OPTIONAL fast-path accelerator. If Redis is down, the API operates in
 *   degraded mode with PostgreSQL fallback, continuing to process transfers safely (returns 200 degraded).
 */
export async function getReadiness(req: Request, res: Response): Promise<void> {
  const [postgres, redis] = await Promise.all([
    checkDbHealth(),
    checkRedisHealth(),
  ]);

  // PostgreSQL is strictly required for readiness
  if (postgres.status !== 'up') {
    res.status(503).json({
      status: 'down',
      ready: false,
      message: 'Required dependency PostgreSQL is unavailable',
      timestamp: new Date().toISOString(),
      services: {
        postgres,
        redis,
      },
    });
    return;
  }

  // If Redis is down, API is ready in degraded mode
  const isDegraded = redis.status !== 'up';
  res.status(200).json({
    status: isDegraded ? 'degraded' : 'ok',
    ready: true,
    degraded: isDegraded,
    message: isDegraded
      ? 'Operating in degraded mode with PostgreSQL durable fallback'
      : 'All dependencies healthy',
    timestamp: new Date().toISOString(),
    services: {
      postgres,
      redis,
    },
  });
}
