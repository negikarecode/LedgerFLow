import Redis, { RedisOptions } from 'ioredis';
import { env } from '../config/env';
import { logger } from '../observability/logger';
import { redisConnectedGauge, redisErrorsTotal } from '../observability/metrics';

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

/**
 * Calculates bounded exponential backoff with jitter for reconnection.
 * Formula: min(maxDelayMs, baseDelayMs * 2^(min(attempt - 1, 10))) + random_jitter
 */
export function calculateRedisBackoff(
  times: number,
  options: BackoffOptions = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 3000;
  const jitterRatio = options.jitterRatio ?? 0.3;

  const attempt = Math.max(1, times);
  const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(attempt - 1, 10)));
  const jitter = Math.floor(Math.random() * (expDelay * jitterRatio));
  return Math.min(maxDelayMs, expDelay + jitter);
}

let redisInstance: Redis | null = null;

/**
 * Creates an application-level Redis client configured for fast failure and degraded fallback.
 * Uses enableOfflineQueue: false so that if Redis is unavailable, commands immediately reject
 * allowing the API to gracefully fall back to PostgreSQL without hanging or blocking HTTP clients.
 */
export function createRedisClient(customUrl?: string, customOptions: RedisOptions = {}): Redis {
  const url = customUrl || env.REDIS_URL;

  const client = new Redis(url, {
    enableReadyCheck: true,
    enableOfflineQueue: false, // Fail fast: do not queue commands when disconnected
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1, // Do not endlessly retry commands when disconnected
    retryStrategy(times) {
      const delay = calculateRedisBackoff(times);
      logger.warn(
        { event: 'redis_reconnecting', attempt: times, delay_ms: delay },
        `[Redis] Reconnecting attempt ${times} with delay ${delay}ms`
      );
      return delay;
    },
    ...customOptions,
  });

  client.on('connect', () => {
    logger.info({ event: 'redis_connected' }, '[Redis] Socket connected to server.');
  });

  client.on('ready', () => {
    logger.info({ event: 'redis_ready' }, '[Redis] Ready to accept commands.');
    redisConnectedGauge.set(1);
  });

  client.on('error', (err: Error) => {
    const isAuthError = err.message.includes('NOAUTH') || err.message.includes('WRONGPASS');
    const operation = isAuthError ? 'auth' : 'connection';
    logger.error(
      { event: 'redis_error', error_type: operation, error: err.message },
      `[Redis] Connection error: ${err.message}`
    );
    redisConnectedGauge.set(0);
    redisErrorsTotal.inc({ operation });
  });

  client.on('close', () => {
    redisConnectedGauge.set(0);
  });

  client.on('end', () => {
    redisConnectedGauge.set(0);
  });

  return client;
}

/**
 * Creates a BullMQ-compatible Redis client.
 * BullMQ requires maxRetriesPerRequest: null and custom connection lifecycle.
 */
export function createBullMQRedisClient(customUrl?: string, customOptions: RedisOptions = {}): Redis {
  const url = customUrl || env.REDIS_URL;

  const client = new Redis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    retryStrategy(times) {
      const delay = calculateRedisBackoff(times);
      logger.warn(
        { event: 'bullmq_redis_reconnecting', attempt: times, delay_ms: delay },
        `[BullMQ Redis] Reconnecting attempt ${times} with delay ${delay}ms`
      );
      return delay;
    },
    ...customOptions,
  });

  client.on('connect', () => {
    logger.info({ event: 'bullmq_redis_connected' }, '[BullMQ Redis] Socket connected.');
  });

  client.on('ready', () => {
    logger.info({ event: 'bullmq_redis_ready' }, '[BullMQ Redis] Ready.');
  });

  client.on('error', (err: Error) => {
    logger.error(
      { event: 'bullmq_redis_error', error: err.message },
      `[BullMQ Redis] Error: ${err.message}`
    );
    redisErrorsTotal.inc({ operation: 'bullmq' });
  });

  return client;
}

export function getRedisClient(): Redis {
  if (!redisInstance) {
    redisInstance = createRedisClient();
  }
  return redisInstance;
}

export const redis = getRedisClient();

/**
 * Performs a health check against Redis with an enforced 1500ms timeout
 * so that an unresponsive Redis never blocks the health check endpoint.
 */
export async function checkRedisHealth(): Promise<{
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis health check timed out after 1500ms')), 1500);
      timer.unref?.();
    });
    const reply = await Promise.race([redis.ping(), timeoutPromise]);
    if (timer) clearTimeout(timer);
    if (reply === 'PONG') {
      return { status: 'up', latencyMs: Date.now() - start };
    }
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: `Unexpected PING response: ${reply}`,
    };
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    return { status: 'down', latencyMs: Date.now() - start, error: err.message };
  }
}

/**
 * Closes the application Redis client cleanly with fallback disconnect.
 */
export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    try {
      await Promise.race([
        redisInstance.quit(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Redis quit timeout')), 1000)
        ),
      ]);
    } catch {
      redisInstance.disconnect();
    }
    redisInstance = null;
  }
}
