import Redis from 'ioredis';
import { env } from '../config/env';

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisInstance) {
    redisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // Recommended for BullMQ
      enableReadyCheck: true,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        return delay;
      },
    });

    redisInstance.on('connect', () => {
      console.log('[Redis] Connected to server.');
    });

    redisInstance.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });
  }

  return redisInstance;
}

export const redis = getRedisClient();

export async function checkRedisHealth(): Promise<{ status: 'up' | 'down'; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const reply = await redis.ping();
    if (reply === 'PONG') {
      return { status: 'up', latencyMs: Date.now() - start };
    }
    return { status: 'down', latencyMs: Date.now() - start, error: `Unexpected PING response: ${reply}` };
  } catch (err: any) {
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    await redisInstance.quit();
    redisInstance = null;
  }
}
