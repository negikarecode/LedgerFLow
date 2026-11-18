import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../../redis/client';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { rateLimitExceededTotal, rateLimitFallbackTotal } from '../../observability/metrics';

/**
 * Lua script for atomic sliding-window rate limiting in Redis using sorted sets.
 * Removes timestamps older than (now - windowMs), computes current window count,
 * inserts current timestamp if under limit, sets TTL, and returns:
 * [allowed (1 or 0), remaining tokens, resetMs until oldest request expires].
 */
const LUA_SLIDING_WINDOW_RATE_LIMITER = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - window

-- Prune requests older than current window
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
  -- Allow request: add current timestamp with unique member
  redis.call('ZADD', key, now, now .. ':' .. math.random(100000, 999999))
  redis.call('EXPIRE', key, math.ceil(window / 1000) * 2)
  return { 1, limit - currentRequests - 1, 0 }
else
  -- Denied: get oldest timestamp to calculate accurate Retry-After resetMs
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = window
  if oldest and #oldest >= 2 then
    resetMs = math.max(0, math.ceil(tonumber(oldest[2]) + window - now))
  end
  return { 0, 0, resetMs }
end
`;

/**
 * Lua script to check current sliding-window status WITHOUT consuming a token.
 * Used by authFailureTracker to inspect whether an IP is currently blocked without
 * penalizing subsequent requests or checks.
 */
const LUA_CHECK_SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local clearBefore = now - window

-- Prune requests older than current window
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
  return { 1, limit - currentRequests, 0 }
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local resetMs = window
  if oldest and #oldest >= 2 then
    resetMs = math.max(0, math.ceil(tonumber(oldest[2]) + window - now))
  end
  return { 0, 0, resetMs }
end
`;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  source: 'redis' | 'in_memory';
}

/**
 * In-memory sliding-window limiter used as an immediate fallback when Redis
 * is unavailable, disconnected, or times out. Ensures protective controls
 * are never silently bypassed.
 */
export class InMemorySlidingWindowLimiter {
  private windows = new Map<string, number[]>();
  private gcInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.gcInterval = setInterval(() => this.cleanup(), 60000);
    this.gcInterval.unref?.();
  }

  consume(
    key: string,
    now: number,
    windowMs: number,
    limit: number
  ): { allowed: boolean; remaining: number; resetMs: number } {
    let timestamps = this.windows.get(key);
    const clearBefore = now - windowMs;

    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    } else {
      timestamps = timestamps.filter((ts) => ts > clearBefore);
      this.windows.set(key, timestamps);
    }

    if (timestamps.length < limit) {
      timestamps.push(now);
      return {
        allowed: true,
        remaining: limit - timestamps.length,
        resetMs: 0,
      };
    } else {
      const oldest = timestamps[0] || now;
      const resetMs = Math.max(0, Math.ceil(oldest + windowMs - now));
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }
  }

  check(
    key: string,
    now: number,
    windowMs: number,
    limit: number
  ): { allowed: boolean; remaining: number; resetMs: number } {
    const rawTimestamps = this.windows.get(key);
    if (!rawTimestamps || rawTimestamps.length === 0) {
      return { allowed: true, remaining: limit, resetMs: 0 };
    }

    const clearBefore = now - windowMs;
    const timestamps = rawTimestamps.filter((ts) => ts > clearBefore);
    this.windows.set(key, timestamps);

    if (timestamps.length < limit) {
      return {
        allowed: true,
        remaining: limit - timestamps.length,
        resetMs: 0,
      };
    } else {
      const oldest = timestamps[0] || now;
      const resetMs = Math.max(0, Math.ceil(oldest + windowMs - now));
      return {
        allowed: false,
        remaining: 0,
        resetMs,
      };
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.windows.entries()) {
      const fresh = timestamps.filter((ts) => ts > now - 120000);
      if (fresh.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, fresh);
      }
    }
  }

  reset(): void {
    this.windows.clear();
  }
}

export const inMemoryLimiter = new InMemorySlidingWindowLimiter();

/**
 * Resolves the client IP address safely according to proxy trust settings.
 * If TRUST_PROXY is false/disabled, ignores X-Forwarded-For to prevent IP spoofing.
 */
export function getClientIp(req: Request): string {
  const trustProxy = req.app?.get('trust proxy');
  const isTrustProxyEnabled = trustProxy !== false && trustProxy !== undefined && trustProxy !== 0;
  if (!isTrustProxyEnabled) {
    // Untrusted proxy: strictly use raw TCP socket address, completely ignoring X-Forwarded-For
    const sockIp = req.socket?.remoteAddress;
    if (sockIp) {
      return sockIp.replace(/^::ffff:/, '');
    }
    return '127.0.0.1';
  }

  // Trusted proxy: Express parses X-Forwarded-For safely according to trust proxy setting
  const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
  return rawIp.replace(/^::ffff:/, '');
}

/**
 * Dual-Engine Rate Limiter:
 * Evaluates rate limit against Redis with atomic Lua sliding window;
 * falls back to in-memory sliding window if Redis fails or times out.
 */
export async function consumeRateLimit(
  key: string,
  windowMs: number,
  limit: number
): Promise<RateLimitResult> {
  const now = Date.now();
  let redisFailed = false;

  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready' && redis.status !== 'connect') {
      redisFailed = true;
    } else {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis rate limit timeout')), 500);
        timer.unref?.();
      });

      const res = (await Promise.race([
        redis.eval(LUA_SLIDING_WINDOW_RATE_LIMITER, 1, key, now, windowMs, limit),
        timeoutPromise,
      ])) as [number, number, number];

      if (timer) clearTimeout(timer);

      return {
        allowed: res[0] === 1,
        remaining: res[1],
        resetMs: res[2],
        source: 'redis',
      };
    }
  } catch (err: any) {
    redisFailed = true;
  }

  if (redisFailed) {
    rateLimitFallbackTotal.inc();
    const fallbackRes = inMemoryLimiter.consume(key, now, windowMs, limit);
    return {
      ...fallbackRes,
      source: 'in_memory',
    };
  }

  return { allowed: true, remaining: limit, resetMs: 0, source: 'in_memory' };
}

/**
 * Dual-Engine Rate Limit Status Checker:
 * Checks whether key is over limit without consuming a token.
 */
export async function checkRateLimit(
  key: string,
  windowMs: number,
  limit: number
): Promise<RateLimitResult> {
  const now = Date.now();
  let redisFailed = false;

  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready' && redis.status !== 'connect') {
      redisFailed = true;
    } else {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Redis rate limit timeout')), 500);
        timer.unref?.();
      });

      const res = (await Promise.race([
        redis.eval(LUA_CHECK_SLIDING_WINDOW, 1, key, now, windowMs, limit),
        timeoutPromise,
      ])) as [number, number, number];

      if (timer) clearTimeout(timer);

      return {
        allowed: res[0] === 1,
        remaining: res[1],
        resetMs: res[2],
        source: 'redis',
      };
    }
  } catch (err: any) {
    redisFailed = true;
  }

  if (redisFailed) {
    rateLimitFallbackTotal.inc();
    const fallbackRes = inMemoryLimiter.check(key, now, windowMs, limit);
    return {
      ...fallbackRes,
      source: 'in_memory',
    };
  }

  return { allowed: true, remaining: limit, resetMs: 0, source: 'in_memory' };
}

export interface RateLimiterMiddlewareOptions {
  tier: 'public' | 'tenant' | 'auth_fail' | 'expensive';
  windowMs: number;
  max: number | (() => number);
  keyGenerator: (req: Request) => string | null;
  message?: string;
  skip?: (req: Request) => boolean;
}

/**
 * Creates an Express rate-limiting middleware enforcing sliding window limits,
 * setting standard X-RateLimit-* and Retry-After headers, and returning HTTP 429 on exhaustion.
 */
export function createRateLimiter(options: RateLimiterMiddlewareOptions) {
  const {
    tier,
    windowMs,
    max,
    keyGenerator,
    message = 'Rate limit exceeded. Please retry after some time.',
    skip,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (env.RATE_LIMIT_ENABLED === false) {
      return next();
    }

    if (skip && skip(req)) {
      return next();
    }

    const keyPart = keyGenerator(req);
    if (!keyPart) {
      return next();
    }

    const effectiveMax = typeof max === 'function' ? max() : max;
    const fullKey = `ratelimit:${tier}:${keyPart}`;
    const result = await consumeRateLimit(fullKey, windowMs, effectiveMax);

    const resetSeconds = Math.max(1, Math.ceil(result.resetMs / 1000));
    const resetTimeSec = Math.ceil((Date.now() + result.resetMs) / 1000);

    // Standard RFC RateLimit headers
    res.setHeader('X-RateLimit-Limit', effectiveMax);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', resetTimeSec);

    if (!result.allowed) {
      rateLimitExceededTotal.inc({ tier, key_type: keyPart.split(':')[0] || 'generic' });
      res.setHeader('Retry-After', resetSeconds);
      res.status(429).json({
        error: 'Too Many Requests',
        message: `${message} Please retry after ${resetSeconds} seconds.`,
        retry_after_seconds: resetSeconds,
      });
      return;
    }

    next();
  };
}

/**
 * 1. Global / Public Rate Limiter:
 * Keyed by client IP. Protects public routes and pre-authentication endpoints.
 */
export const publicRateLimiter = createRateLimiter({
  tier: 'public',
  windowMs: 60000,
  max: () => env.RATE_LIMIT_GLOBAL_MAX ?? (process.env.NODE_ENV === 'test' ? 10000 : 300),
  keyGenerator: (req) => `ip:${getClientIp(req)}`,
  message: 'Public request limit exceeded.',
  skip: (req) =>
    req.path === '/health/live' ||
    req.path === '/health/ready' ||
    req.path === '/livez' ||
    req.path === '/readyz' ||
    req.path === '/metrics',
});

/**
 * 2. Authenticated Tenant Rate Limiter:
 * Applied after requireApiKey. Keyed by authenticated tenant ID (req.merchant.id).
 * Protects merchant endpoints with generous burst capacity while ensuring tenant isolation.
 */
export const tenantRateLimiter = createRateLimiter({
  tier: 'tenant',
  windowMs: 60000,
  max: () => env.RATE_LIMIT_TENANT_MAX ?? (process.env.NODE_ENV === 'test' ? 10000 : 1200),
  keyGenerator: (req) => {
    const merchantId = req.merchant?.id;
    return merchantId ? `tenant:${merchantId}` : `ip:${getClientIp(req)}`;
  },
  message: 'Tenant API rate limit exceeded.',
});

/**
 * 3. Expensive Endpoints Rate Limiter:
 * Keyed per tenant/IP on computationally heavy or batch operations:
 * - POST /admin/reconcile
 * - POST /outbox/replay-batch
 * - POST /webhook-endpoints
 */
export const expensiveRateLimiter = createRateLimiter({
  tier: 'expensive',
  windowMs: 60000,
  max: () => env.RATE_LIMIT_EXPENSIVE_MAX ?? (process.env.NODE_ENV === 'test' ? 10000 : 60),
  keyGenerator: (req) => {
    const id = req.merchant?.id || getClientIp(req);
    return `${id}:${req.baseUrl || ''}${req.path}`;
  },
  message: 'Expensive operation rate limit exceeded.',
});

/**
 * 4. Authentication Failure Tracker & Rate Limiter:
 * Tracks consecutive authentication failures per IP address (brute force protection).
 * If threshold is exceeded, blocks further auth requests from that IP with HTTP 429.
 */
export class AuthFailureTracker {
  private windowMs = 60000;

  private getMaxFailures(): number {
    return env.RATE_LIMIT_AUTH_FAIL_MAX ?? (process.env.NODE_ENV === 'test' ? 1000 : 20);
  }

  async isBlocked(ip: string): Promise<{ blocked: boolean; resetSeconds: number }> {
    const key = `ratelimit:auth_fail:${ip}`;
    const max = this.getMaxFailures();
    const result = await checkRateLimit(key, this.windowMs, max);
    if (!result.allowed) {
      rateLimitExceededTotal.inc({ tier: 'auth_fail', key_type: 'ip' });
      return {
        blocked: true,
        resetSeconds: Math.max(1, Math.ceil(result.resetMs / 1000)),
      };
    }
    return { blocked: false, resetSeconds: 0 };
  }

  async recordFailure(ip: string): Promise<void> {
    const key = `ratelimit:auth_fail:${ip}`;
    const max = this.getMaxFailures();
    await consumeRateLimit(key, this.windowMs, max);
  }

  reset(): void {
    inMemoryLimiter.reset();
  }
}

export const authFailureTracker = new AuthFailureTracker();

/**
 * 5. Early Payload Size Guard:
 * Checks Content-Length header upfront before reading the stream.
 * Immediately rejects oversized payloads with HTTP 413 without memory allocation.
 */
export function earlyPayloadSizeGuard(maxBytes = 262144) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const parsed = parseInt(contentLength, 10);
      if (!isNaN(parsed) && parsed > maxBytes) {
        res.status(413).json({
          error: 'Payload Too Large',
          message: `Request payload exceeded maximum size limit of ${Math.round(maxBytes / 1024)}KB`,
        });
        return;
      }
    }
    next();
  };
}

/**
 * 6. Request Timeout Guard:
 * Enforces a strict server-side deadline on request processing (default 15,000ms).
 * If the response does not complete within timeoutMs, responds with HTTP 504 Gateway Timeout.
 */
export function requestTimeoutGuard(timeoutMs = 15000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn(
          { event: 'request_timeout', method: req.method, url: req.originalUrl, timeoutMs },
          `[Server] Request exceeded timeout deadline of ${timeoutMs}ms`
        );
        res.status(504).json({
          error: 'Gateway Timeout',
          message: `Request processing exceeded timeout deadline of ${timeoutMs}ms`,
        });
      }
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    res.once('finish', cleanup);
    res.once('close', cleanup);

    next();
  };
}
