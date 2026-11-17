import { getRedisClient } from '../redis/client';
import { query } from '../db/pool';
import { env } from '../config/env';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  consecutiveFailuresThreshold?: number;
  cooldownSeconds?: number;
  errorRateThreshold?: number;
  rollingWindowSeconds?: number;
  minRequestsInWindow?: number;
  probeTimeoutSeconds?: number;
}

export interface BreakerCheckResult {
  allowed: boolean;
  state: CircuitBreakerState;
  delayMs?: number;
  isProbe?: boolean;
}

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutive_failures: number;
  opened_at: string | null;
  last_failure_at: string | null;
  cooldown_remaining_seconds: number;
}

export class EndpointCircuitBreaker {
  private config: Required<CircuitBreakerConfig>;

  constructor(customConfig?: CircuitBreakerConfig) {
    this.config = {
      consecutiveFailuresThreshold:
        customConfig?.consecutiveFailuresThreshold ??
        env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ??
        10,
      cooldownSeconds:
        customConfig?.cooldownSeconds ??
        env.CIRCUIT_BREAKER_COOLDOWN_SECONDS ??
        30,
      errorRateThreshold:
        customConfig?.errorRateThreshold ??
        env.CIRCUIT_BREAKER_ERROR_RATE_THRESHOLD ??
        0.5,
      rollingWindowSeconds: customConfig?.rollingWindowSeconds ?? 60,
      minRequestsInWindow:
        customConfig?.minRequestsInWindow ??
        customConfig?.consecutiveFailuresThreshold ??
        env.CIRCUIT_BREAKER_FAILURE_THRESHOLD ??
        10,
      probeTimeoutSeconds: customConfig?.probeTimeoutSeconds ?? 15,
    };
  }

  private getKey(endpointId: string): string {
    return `cb:endpoint:${endpointId}`;
  }

  private getEventsKey(endpointId: string): string {
    return `cb:endpoint:${endpointId}:events`;
  }

  private getProbeKey(endpointId: string): string {
    return `cb:endpoint:${endpointId}:probe`;
  }

  /**
   * Evaluates if a delivery attempt is allowed through the circuit breaker.
   */
  async canAttemptDelivery(endpointId?: string): Promise<BreakerCheckResult> {
    if (!endpointId) {
      return { allowed: true, state: 'CLOSED' };
    }

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);
      const data = await redis.hgetall(key);

      const now = Date.now();
      let state: CircuitBreakerState = (data.state as CircuitBreakerState) || 'CLOSED';
      const openedAt = data.opened_at ? Number(data.opened_at) : 0;
      const cooldownMs = this.config.cooldownSeconds * 1000;

      if (state === 'OPEN') {
        const elapsed = now - openedAt;
        if (elapsed < cooldownMs) {
          // Still within cooldown period
          const remainingMs = Math.max(1000, cooldownMs - elapsed);
          return {
            allowed: false,
            state: 'OPEN',
            delayMs: remainingMs,
          };
        } else {
          // Cooldown elapsed: transition to HALF_OPEN
          state = 'HALF_OPEN';
          await redis.hset(key, 'state', 'HALF_OPEN');
        }
      }

      if (state === 'HALF_OPEN') {
        // Attempt to acquire probe token
        const probeKey = this.getProbeKey(endpointId);
        const acquired = await redis.set(
          probeKey,
          '1',
          'PX',
          this.config.probeTimeoutSeconds * 1000,
          'NX'
        );

        if (acquired === 'OK') {
          return {
            allowed: true,
            state: 'HALF_OPEN',
            isProbe: true,
          };
        } else {
          // Another worker is currently testing the probe
          return {
            allowed: false,
            state: 'HALF_OPEN',
            delayMs: 2000,
          };
        }
      }

      return { allowed: true, state: 'CLOSED' };
    } catch (redisErr: any) {
      console.warn(
        `[Circuit Breaker] Redis error, falling back to PostgreSQL:`,
        redisErr.message
      );
      return this.checkPostgresFallback(endpointId);
    }
  }

  /**
   * Records a successful delivery attempt.
   */
  async recordSuccess(endpointId?: string, isProbe = false): Promise<void> {
    if (!endpointId) return;

    const now = Date.now();

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);
      const eventsKey = this.getEventsKey(endpointId);
      const probeKey = this.getProbeKey(endpointId);

      // Reset failure counters & close breaker
      await redis
        .multi()
        .hset(key, {
          state: 'CLOSED',
          consecutive_failures: '0',
          opened_at: '',
        })
        .del(probeKey)
        .zremrangebyscore(eventsKey, 0, now - this.config.rollingWindowSeconds * 1000)
        .zadd(eventsKey, now, `${now}:1`)
        .expire(eventsKey, this.config.rollingWindowSeconds * 2)
        .exec();

      // Async sync to PostgreSQL fallback
      query(
        `UPDATE webhook_endpoints 
         SET circuit_breaker_state = 'CLOSED', consecutive_failures = 0, cb_opened_at = NULL 
         WHERE id = $1`,
        [endpointId]
      ).catch(() => {});
    } catch (redisErr: any) {
      console.warn(`[Circuit Breaker] Redis success recording error:`, redisErr.message);
      query(
        `UPDATE webhook_endpoints 
         SET circuit_breaker_state = 'CLOSED', consecutive_failures = 0, cb_opened_at = NULL 
         WHERE id = $1`,
        [endpointId]
      ).catch(() => {});
    }
  }

  /**
   * Records a failed delivery attempt. Trips breaker to OPEN if threshold reached.
   */
  async recordFailure(endpointId?: string, isProbe = false): Promise<{ tripped: boolean }> {
    if (!endpointId) return { tripped: false };

    const now = Date.now();

    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);
      const eventsKey = this.getEventsKey(endpointId);
      const probeKey = this.getProbeKey(endpointId);

      // Clear probe lock if this was a probe
      if (isProbe) {
        await redis.del(probeKey);
      }

      // Check current state
      const currentData = await redis.hgetall(key);
      const currentState = (currentData.state as CircuitBreakerState) || 'CLOSED';

      if (currentState === 'HALF_OPEN' || isProbe) {
        // Probe failed -> reopen immediately
        await redis.hset(key, {
          state: 'OPEN',
          opened_at: String(now),
          last_failure_at: String(now),
        });

        query(
          `UPDATE webhook_endpoints 
           SET circuit_breaker_state = 'OPEN', cb_opened_at = NOW(), cb_last_failure_at = NOW() 
           WHERE id = $1`,
          [endpointId]
        ).catch(() => {});

        return { tripped: true };
      }

      // Update consecutive failures and rolling window
      const newFailures = await redis.hincrby(key, 'consecutive_failures', 1);
      await redis.hset(key, 'last_failure_at', String(now));

      await redis.zremrangebyscore(
        eventsKey,
        0,
        now - this.config.rollingWindowSeconds * 1000
      );
      await redis.zadd(eventsKey, now, `${now}:0`);
      await redis.expire(eventsKey, this.config.rollingWindowSeconds * 2);

      // Check consecutive failure threshold
      let shouldTrip = newFailures >= this.config.consecutiveFailuresThreshold;

      // Check rolling window error rate
      if (!shouldTrip) {
        const events = await redis.zrangebyscore(
          eventsKey,
          now - this.config.rollingWindowSeconds * 1000,
          '+inf'
        );

        if (events.length >= this.config.minRequestsInWindow) {
          const failures = events.filter((e) => e.endsWith(':0')).length;
          const errorRate = failures / events.length;
          if (errorRate >= this.config.errorRateThreshold) {
            shouldTrip = true;
          }
        }
      }

      if (shouldTrip) {
        await redis.hset(key, {
          state: 'OPEN',
          opened_at: String(now),
          last_failure_at: String(now),
        });

        query(
          `UPDATE webhook_endpoints 
           SET circuit_breaker_state = 'OPEN', consecutive_failures = $2, cb_opened_at = NOW(), cb_last_failure_at = NOW() 
           WHERE id = $1`,
          [endpointId, newFailures]
        ).catch(() => {});

        return { tripped: true };
      }

      // Sync failure to PostgreSQL fallback
      query(
        `UPDATE webhook_endpoints 
         SET consecutive_failures = $2, cb_last_failure_at = NOW() 
         WHERE id = $1`,
        [endpointId, newFailures]
      ).catch(() => {});

      return { tripped: false };
    } catch (redisErr: any) {
      console.warn(`[Circuit Breaker] Redis failure recording error:`, redisErr.message);
      return this.recordFailurePostgresFallback(endpointId, isProbe);
    }
  }

  /**
   * Retrieves the current circuit breaker status for an endpoint.
   */
  async getStatus(endpointId: string): Promise<CircuitBreakerStatus> {
    try {
      const redis = getRedisClient();
      const key = this.getKey(endpointId);
      const data = await redis.hgetall(key);

      const now = Date.now();
      let state: CircuitBreakerState = (data.state as CircuitBreakerState) || 'CLOSED';
      const consecutiveFailures = Number(data.consecutive_failures || 0);
      const openedAtMs = data.opened_at ? Number(data.opened_at) : null;
      const lastFailureAtMs = data.last_failure_at ? Number(data.last_failure_at) : null;

      let cooldownRemaining = 0;
      if (state === 'OPEN' && openedAtMs) {
        const elapsed = (now - openedAtMs) / 1000;
        cooldownRemaining = Math.max(0, Math.ceil(this.config.cooldownSeconds - elapsed));
        if (cooldownRemaining === 0) {
          state = 'HALF_OPEN';
        }
      }

      return {
        state,
        consecutive_failures: consecutiveFailures,
        opened_at: openedAtMs ? new Date(openedAtMs).toISOString() : null,
        last_failure_at: lastFailureAtMs ? new Date(lastFailureAtMs).toISOString() : null,
        cooldown_remaining_seconds: cooldownRemaining,
      };
    } catch {
      return this.getStatusPostgresFallback(endpointId);
    }
  }

  /**
   * Resets the circuit breaker state (useful for testing or manual intervention).
   */
  async reset(endpointId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(
        this.getKey(endpointId),
        this.getEventsKey(endpointId),
        this.getProbeKey(endpointId)
      );
    } catch {}

    try {
      await query(
        `UPDATE webhook_endpoints 
         SET circuit_breaker_state = 'CLOSED', consecutive_failures = 0, cb_opened_at = NULL 
         WHERE id = $1`,
        [endpointId]
      );
    } catch {}
  }

  /**
   * PostgreSQL Fallback for checking delivery permission when Redis is unavailable.
   */
  private async checkPostgresFallback(endpointId: string): Promise<BreakerCheckResult> {
    try {
      const res = await query(
        `SELECT circuit_breaker_state, consecutive_failures, cb_opened_at 
         FROM webhook_endpoints WHERE id = $1`,
        [endpointId]
      );

      if (res.rows.length === 0) {
        return { allowed: true, state: 'CLOSED' };
      }

      const row = res.rows[0];
      const state = (row.circuit_breaker_state as CircuitBreakerState) || 'CLOSED';
      const openedAt = row.cb_opened_at ? new Date(row.cb_opened_at).getTime() : 0;
      const cooldownMs = this.config.cooldownSeconds * 1000;
      const now = Date.now();

      if (state === 'OPEN') {
        const elapsed = now - openedAt;
        if (elapsed < cooldownMs) {
          return {
            allowed: false,
            state: 'OPEN',
            delayMs: Math.max(1000, cooldownMs - elapsed),
          };
        } else {
          return { allowed: true, state: 'HALF_OPEN', isProbe: true };
        }
      }

      return { allowed: true, state: 'CLOSED' };
    } catch {
      // Safe default if everything fails: allow delivery
      return { allowed: true, state: 'CLOSED' };
    }
  }

  /**
   * PostgreSQL Fallback for recording failure when Redis is unavailable.
   */
  private async recordFailurePostgresFallback(
    endpointId: string,
    isProbe = false
  ): Promise<{ tripped: boolean }> {
    try {
      const res = await query(
        `SELECT consecutive_failures, circuit_breaker_state 
         FROM webhook_endpoints WHERE id = $1`,
        [endpointId]
      );

      if (res.rows.length === 0) return { tripped: false };

      const current = res.rows[0];
      const nextFailures = (current.consecutive_failures || 0) + 1;
      const shouldTrip =
        isProbe ||
        current.circuit_breaker_state === 'HALF_OPEN' ||
        nextFailures >= this.config.consecutiveFailuresThreshold;

      if (shouldTrip) {
        await query(
          `UPDATE webhook_endpoints 
           SET circuit_breaker_state = 'OPEN', consecutive_failures = $2, cb_opened_at = NOW(), cb_last_failure_at = NOW() 
           WHERE id = $1`,
          [endpointId, nextFailures]
        );
        return { tripped: true };
      } else {
        await query(
          `UPDATE webhook_endpoints 
           SET consecutive_failures = $2, cb_last_failure_at = NOW() 
           WHERE id = $1`,
          [endpointId, nextFailures]
        );
        return { tripped: false };
      }
    } catch {
      return { tripped: false };
    }
  }

  /**
   * PostgreSQL Fallback for getting status when Redis is unavailable.
   */
  private async getStatusPostgresFallback(endpointId: string): Promise<CircuitBreakerStatus> {
    try {
      const res = await query(
        `SELECT circuit_breaker_state, consecutive_failures, cb_opened_at, cb_last_failure_at 
         FROM webhook_endpoints WHERE id = $1`,
        [endpointId]
      );

      if (res.rows.length === 0) {
        return {
          state: 'CLOSED',
          consecutive_failures: 0,
          opened_at: null,
          last_failure_at: null,
          cooldown_remaining_seconds: 0,
        };
      }

      const row = res.rows[0];
      let state = (row.circuit_breaker_state as CircuitBreakerState) || 'CLOSED';
      let cooldownRemaining = 0;

      if (state === 'OPEN' && row.cb_opened_at) {
        const openedAt = new Date(row.cb_opened_at).getTime();
        const elapsed = (Date.now() - openedAt) / 1000;
        cooldownRemaining = Math.max(0, Math.ceil(this.config.cooldownSeconds - elapsed));
        if (cooldownRemaining === 0) {
          state = 'HALF_OPEN';
        }
      }

      return {
        state,
        consecutive_failures: Number(row.consecutive_failures || 0),
        opened_at: row.cb_opened_at ? new Date(row.cb_opened_at).toISOString() : null,
        last_failure_at: row.cb_last_failure_at ? new Date(row.cb_last_failure_at).toISOString() : null,
        cooldown_remaining_seconds: cooldownRemaining,
      };
    } catch {
      return {
        state: 'CLOSED',
        consecutive_failures: 0,
        opened_at: null,
        last_failure_at: null,
        cooldown_remaining_seconds: 0,
      };
    }
  }
}

export const circuitBreaker = new EndpointCircuitBreaker();
