import { Request, Response } from 'express';
import { checkDbHealth } from '../../db/pool';
import { checkRedisHealth } from '../../redis/client';

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
