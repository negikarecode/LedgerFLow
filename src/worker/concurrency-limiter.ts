import { getRedisClient } from '../redis/client';
import { env } from '../config/env';

export class EndpointConcurrencyLimiter {
  private defaultMaxConcurrent: number;

  constructor(maxConcurrent?: number) {
    this.defaultMaxConcurrent =
      maxConcurrent ?? env.WEBHOOK_MAX_CONCURRENT_PER_ENDPOINT ?? 3;
  }

  private getKey(endpointId: string): string {
    return `concurrency:endpoint:${endpointId}`;
  }

  /**
   * Attempts to acquire an in-flight execution slot for an endpoint.
   */
  async acquire(
    endpointId?: string,
    customMax?: number
  ): Promise<{ allowed: boolean; inFlight: number }> {
    if (!endpointId) {
      return { allowed: true, inFlight: 0 };
    }

    const max = customMax ?? this.defaultMaxConcurrent;

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);

      const count = await redis.incr(key);
      await redis.expire(key, 30); // 30s auto-expiry prevents permanent lockup on unexpected crashes

      if (count > max) {
        // Exceeded limit: release and reject
        await redis.decr(key);
        return { allowed: false, inFlight: count - 1 };
      }

      return { allowed: true, inFlight: count };
    } catch (err: any) {
      console.warn(`[Concurrency Limiter] Redis error, failing open:`, err.message);
      return { allowed: true, inFlight: 0 };
    }
  }

  /**
   * Releases an acquired in-flight slot for an endpoint.
   */
  async release(endpointId?: string): Promise<void> {
    if (!endpointId) return;

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);
      const count = await redis.decr(key);
      if (count < 0) {
        await redis.set(key, 0);
      }
    } catch {}
  }

  /**
   * Resets concurrency counter for an endpoint.
   */
  async reset(endpointId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(this.getKey(endpointId));
    } catch {}
  }
}

export const concurrencyLimiter = new EndpointConcurrencyLimiter();
