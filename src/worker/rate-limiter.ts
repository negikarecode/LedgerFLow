import { getRedisClient } from '../redis/client';
import { env } from '../config/env';

export interface RateLimiterResult {
  allowed: boolean;
  waitMs: number;
  remainingTokens?: number;
}

export interface RateLimiterConfig {
  deliveriesPerSecond?: number;
  burstCapacity?: number;
}

const TOKEN_BUCKET_LUA_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2]) -- tokens per second
local requested = tonumber(ARGV[3])    -- tokens to consume
local now_ms = tonumber(ARGV[4])

-- Get current bucket state
local data = redis.call('HMGET', key, 'tokens', 'last_ts')
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if not tokens or not last_ts then
    tokens = capacity
    last_ts = now_ms
else
    -- Calculate elapsed time and refilled tokens
    local elapsed_ms = math.max(0, now_ms - last_ts)
    local refilled = (elapsed_ms / 1000.0) * refill_rate
    tokens = math.min(capacity, tokens + refilled)
    last_ts = now_ms
end

if tokens >= requested then
    tokens = tokens - requested
    redis.call('HMSET', key, 'tokens', tokens, 'last_ts', last_ts)
    redis.call('EXPIRE', key, 3600)
    return { 1, 0, math.floor(tokens) }
else
    local needed = requested - tokens
    local wait_ms = math.ceil((needed / refill_rate) * 1000.0)
    redis.call('HMSET', key, 'tokens', tokens, 'last_ts', last_ts)
    redis.call('EXPIRE', key, 3600)
    return { 0, math.max(100, wait_ms), math.floor(tokens) }
end
`;

export class EndpointRateLimiter {
  private defaultRate: number;
  private defaultBurst: number;

  constructor(config?: RateLimiterConfig) {
    this.defaultRate = config?.deliveriesPerSecond ?? env.WEBHOOK_RATE_LIMIT_PER_SECOND ?? 10;
    this.defaultBurst = config?.burstCapacity ?? env.WEBHOOK_RATE_LIMIT_BURST ?? 20;
  }

  private getKey(endpointId: string): string {
    return `ratelimit:endpoint:${endpointId}`;
  }

  /**
   * Evaluates if a delivery can proceed under the per-endpoint token bucket rate limit.
   * If insufficient tokens are available, returns waitMs for rescheduling without dropping.
   */
  async consume(
    endpointId?: string,
    customRate?: number,
    customBurst?: number
  ): Promise<RateLimiterResult> {
    if (!endpointId) {
      return { allowed: true, waitMs: 0 };
    }

    const rate = customRate ?? this.defaultRate;
    const burst = customBurst ?? this.defaultBurst;
    const requested = 1;
    const now = Date.now();

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);

      const result = (await redis.eval(
        TOKEN_BUCKET_LUA_SCRIPT,
        1,
        key,
        burst,
        rate,
        requested,
        now
      )) as [number, number, number];

      const allowed = result[0] === 1;
      const waitMs = result[1];
      const remainingTokens = result[2];

      return {
        allowed,
        waitMs,
        remainingTokens,
      };
    } catch (redisErr: any) {
      console.warn(
        `[Rate Limiter] Redis error in token bucket eval, failing open:`,
        redisErr.message
      );
      // Safe fallback: allow delivery when rate limiter storage is degraded
      return { allowed: true, waitMs: 0 };
    }
  }

  /**
   * Resets the rate limit bucket for an endpoint (used in tests).
   */
  async reset(endpointId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(this.getKey(endpointId));
    } catch {}
  }

  /**
   * Get current rate limit settings for an endpoint.
   */
  getSettings(customRate?: number, customBurst?: number): {
    deliveries_per_second: number;
    burst: number;
  } {
    return {
      deliveries_per_second: customRate ?? this.defaultRate,
      burst: customBurst ?? this.defaultBurst,
    };
  }
}

export const rateLimiter = new EndpointRateLimiter();
