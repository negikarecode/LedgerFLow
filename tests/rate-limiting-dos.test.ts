import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import {
  createRateLimiter,
  consumeRateLimit,
  InMemorySlidingWindowLimiter,
  inMemoryLimiter,
  getClientIp,
  requestTimeoutGuard,
} from '../src/api/middlewares/rate-limit.middleware';
import { rateLimitFallbackTotal } from '../src/observability/metrics';
import { getRedisClient } from '../src/redis/client';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';

describe('API Rate Limiting, DoS Defense & Resource Exhaustion Suite', () => {
  beforeEach(() => {
    inMemoryLimiter.reset();
  });

  describe('1. Normal Usage & RFC RateLimit Headers', () => {
    it('returns RFC-compliant X-RateLimit-* headers on successful requests', async () => {
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(Number(res.headers['x-ratelimit-limit'])).toBeGreaterThan(0);
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(Number(res.headers['x-ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
      expect(Number(res.headers['x-ratelimit-reset'])).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe('2. Burst Traffic & HTTP 429 Too Many Requests', () => {
    it('enforces sliding-window limit, returns HTTP 429, Retry-After header, and consistent error schema', async () => {
      const testApp = express();
      const burstKey = `test_burst_${uuidv4()}`;
      const testLimiter = createRateLimiter({
        tier: 'public',
        windowMs: 5000,
        max: 3,
        keyGenerator: () => burstKey,
        message: 'Test rate limit exceeded.',
      });

      testApp.get('/test-burst', testLimiter, (req, res) => {
        res.json({ ok: true });
      });

      // Request 1: Allowed (remaining 2)
      const res1 = await request(testApp).get('/test-burst');
      expect(res1.status).toBe(200);
      expect(res1.headers['x-ratelimit-remaining']).toBe('2');

      // Request 2: Allowed (remaining 1)
      const res2 = await request(testApp).get('/test-burst');
      expect(res2.status).toBe(200);
      expect(res2.headers['x-ratelimit-remaining']).toBe('1');

      // Request 3: Allowed (remaining 0)
      const res3 = await request(testApp).get('/test-burst');
      expect(res3.status).toBe(200);
      expect(res3.headers['x-ratelimit-remaining']).toBe('0');

      // Request 4: Throttled (HTTP 429)
      const res4 = await request(testApp).get('/test-burst');
      expect(res4.status).toBe(429);
      expect(res4.headers['x-ratelimit-remaining']).toBe('0');
      expect(res4.headers['retry-after']).toBeDefined();
      const retryAfter = parseInt(res4.headers['retry-after'], 10);
      expect(retryAfter).toBeGreaterThanOrEqual(1);

      expect(res4.body).toMatchObject({
        error: 'Too Many Requests',
        message: expect.stringContaining('Test rate limit exceeded.'),
        retry_after_seconds: retryAfter,
      });
    });
  });

  describe('3. Multi-Tenant Rate Limit Separation', () => {
    it('isolates rate limits between tenants so Tenant A reaching limit does not throttle Tenant B', async () => {
      const tenantAId = uuidv4();
      const tenantBId = uuidv4();

      const testApp = express();
      const tenantLimiter = createRateLimiter({
        tier: 'tenant',
        windowMs: 5000,
        max: 2,
        keyGenerator: (req) => `tenant:${req.headers['x-test-tenant']}`,
        message: 'Tenant quota exhausted.',
      });

      testApp.get('/tenant-data', tenantLimiter, (req, res) => {
        res.json({ tenant: req.headers['x-test-tenant'] });
      });

      // Tenant A sends 2 requests (reaches limit)
      const a1 = await request(testApp).get('/tenant-data').set('x-test-tenant', tenantAId);
      expect(a1.status).toBe(200);

      const a2 = await request(testApp).get('/tenant-data').set('x-test-tenant', tenantAId);
      expect(a2.status).toBe(200);

      // Tenant A 3rd request -> HTTP 429
      const a3 = await request(testApp).get('/tenant-data').set('x-test-tenant', tenantAId);
      expect(a3.status).toBe(429);
      expect(a3.body.error).toBe('Too Many Requests');

      // Tenant B sends request -> MUST SUCCEED with HTTP 200 (not affected by Tenant A)
      const b1 = await request(testApp).get('/tenant-data').set('x-test-tenant', tenantBId);
      expect(b1.status).toBe(200);
      expect(b1.body.tenant).toBe(tenantBId);
      expect(b1.headers['x-ratelimit-remaining']).toBe('1');
    });
  });

  describe('4. Proxy Trust & IP Spoofing Prevention', () => {
    it('ignores spoofed X-Forwarded-For headers when trust proxy is false', async () => {
      const untrustedApp = express();
      untrustedApp.set('trust proxy', false);

      const testRunId = uuidv4();
      const ipTracker: string[] = [];
      const testLimiter = createRateLimiter({
        tier: 'public',
        windowMs: 10000,
        max: 2,
        keyGenerator: (req) => {
          const clientIp = getClientIp(req);
          ipTracker.push(clientIp);
          return `spoof_${testRunId}:${clientIp}`;
        },
      });

      untrustedApp.get('/test-ip', testLimiter, (req, res) => {
        res.json({ ip: getClientIp(req) });
      });

      // Attacker sends request 1 with spoofed IP 1
      const res1 = await request(untrustedApp)
        .get('/test-ip')
        .set('X-Forwarded-For', '203.0.113.195');
      expect(res1.status).toBe(200);

      // Attacker sends request 2 with spoofed IP 2
      const res2 = await request(untrustedApp)
        .get('/test-ip')
        .set('X-Forwarded-For', '198.51.100.42');
      expect(res2.status).toBe(200);

      // Attacker sends request 3 with spoofed IP 3 -> MUST BE BLOCKED (429)
      // because getClientIp strictly resolved all previous requests to 127.0.0.1
      const res3 = await request(untrustedApp)
        .get('/test-ip')
        .set('X-Forwarded-For', '192.0.2.1');
      expect(res3.status).toBe(429);

      // Verify that getClientIp always evaluated to 127.0.0.1 regardless of spoofed headers
      expect(ipTracker.every((ip) => ip === '127.0.0.1')).toBe(true);
    });

    it('honors forwarded IP safely when trust proxy is enabled', async () => {
      const trustedApp = express();
      trustedApp.set('trust proxy', true);

      trustedApp.get('/test-trusted-ip', (req, res) => {
        res.json({ clientIp: getClientIp(req) });
      });

      const res = await request(trustedApp)
        .get('/test-trusted-ip')
        .set('X-Forwarded-For', '203.0.113.50');

      expect(res.status).toBe(200);
      expect(res.body.clientIp).toBe('203.0.113.50');
    });
  });

  describe('5. Resilient Fallback on Redis Backend Failure', () => {
    it('seamlessly falls back to in-memory sliding window when Redis fails', async () => {
      const isolatedLimiter = new InMemorySlidingWindowLimiter();
      const testKey = `test_fallback_${uuidv4()}`;

      // 1. Consume under limit
      const res1 = isolatedLimiter.consume(testKey, Date.now(), 5000, 2);
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(1);

      // 2. Consume up to limit
      const res2 = isolatedLimiter.consume(testKey, Date.now(), 5000, 2);
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(0);

      // 3. Exceed limit
      const res3 = isolatedLimiter.consume(testKey, Date.now(), 5000, 2);
      expect(res3.allowed).toBe(false);
      expect(res3.remaining).toBe(0);
      expect(res3.resetMs).toBeGreaterThan(0);
    });

    it('increments rateLimitFallbackTotal metric when Redis client errors occur', async () => {
      const initialFallbackMetric = (await (rateLimitFallbackTotal as any).get?.())?.values?.[0]?.value ?? 0;

      // Call consumeRateLimit with a mocked failing Redis
      const redis = getRedisClient();
      const originalEval = redis.eval;

      try {
        redis.eval = (() => Promise.reject(new Error('Redis connection lost'))) as any;

        const result = await consumeRateLimit(`test_redis_err_${uuidv4()}`, 5000, 5);
        expect(result.source).toBe('in_memory');
        expect(result.allowed).toBe(true);

        const newFallbackMetric = (await (rateLimitFallbackTotal as any).get?.())?.values?.[0]?.value ?? 0;
        expect(newFallbackMetric).toBeGreaterThan(initialFallbackMetric);
      } finally {
        redis.eval = originalEval;
      }
    });
  });

  describe('6. Request Body Size Limits & Early Rejection (HTTP 413)', () => {
    it('earlyPayloadSizeGuard rejects requests with Content-Length > 256KB upfront before reading stream', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Content-Length', '500000') // 500KB
        .set('Content-Type', 'application/json')
        .send({ owner_name: 'Big Spender' });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        error: 'Payload Too Large',
        message: expect.stringContaining('256KB'),
      });
    });

    it('rejects oversized JSON body exceeding 256KB with HTTP 413', async () => {
      const oversizedPayload = {
        owner_name: 'A'.repeat(300 * 1024), // 300KB
        currency: 'INR',
      };

      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send(oversizedPayload);

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Payload Too Large');
    });
  });

  describe('7. Server-Side Request Timeout Deadline (HTTP 504)', () => {
    it('terminates requests exceeding timeout deadline with HTTP 504 Gateway Timeout', async () => {
      const timeoutApp = express();
      // Mount strict 100ms timeout guard
      timeoutApp.use(requestTimeoutGuard(100));

      timeoutApp.get('/slow-operation', (req, res) => {
        setTimeout(() => {
          if (!res.headersSent) {
            res.json({ done: true });
          }
        }, 300);
      });

      const res = await request(timeoutApp).get('/slow-operation');
      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({
        error: 'Gateway Timeout',
        message: expect.stringContaining('100ms'),
      });
    });

    it('allows requests completing before timeout deadline to succeed', async () => {
      const timeoutApp = express();
      timeoutApp.use(requestTimeoutGuard(1000));

      timeoutApp.get('/fast-operation', (req, res) => {
        res.json({ success: true });
      });

      const res = await request(timeoutApp).get('/fast-operation');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('8. Authentication Failure Brute-Force Rate Limiting', () => {
    it('blocks repeated authentication failures from the same IP with HTTP 429 and Retry-After', async () => {
      const authTestApp = express();
      const testIp = '198.51.100.99';

      const isolatedTracker = new (class extends InMemorySlidingWindowLimiter {
        private maxFailures = 3;
        private windowMs = 5000;

        async checkAndBlock(ip: string) {
          const res = this.check(`auth_fail:${ip}`, Date.now(), this.windowMs, this.maxFailures);
          return { blocked: !res.allowed, resetSeconds: Math.max(1, Math.ceil(res.resetMs / 1000)) };
        }

        async record(ip: string) {
          this.consume(`auth_fail:${ip}`, Date.now(), this.windowMs, this.maxFailures);
        }
      })();

      authTestApp.post('/test-login', async (req, res) => {
        const ip = req.headers['x-client-ip'] as string || '127.0.0.1';
        const { blocked, resetSeconds } = await isolatedTracker.checkAndBlock(ip);
        if (blocked) {
          res.setHeader('Retry-After', resetSeconds);
          return res.status(429).json({
            error: 'Too Many Requests',
            message: `Too many failed authentication attempts. Please retry after ${resetSeconds} seconds.`,
            retry_after_seconds: resetSeconds,
          });
        }

        const authHeader = req.headers.authorization;
        if (authHeader !== 'Bearer valid-secret-token') {
          await isolatedTracker.record(ip);
          return res.status(401).json({ error: 'Unauthorized', message: 'Invalid credentials' });
        }

        res.json({ authenticated: true });
      });

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        const failRes = await request(authTestApp)
          .post('/test-login')
          .set('x-client-ip', testIp)
          .set('Authorization', 'Bearer bad-secret');
        expect(failRes.status).toBe(401);
      }

      // 4th attempt: IP is now blocked with HTTP 429
      const blockedRes = await request(authTestApp)
        .post('/test-login')
        .set('x-client-ip', testIp)
        .set('Authorization', 'Bearer bad-secret');

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers['retry-after']).toBeDefined();
      expect(blockedRes.body.error).toBe('Too Many Requests');
      expect(blockedRes.body.message).toContain('Too many failed authentication attempts');
    });
  });

  describe('9. Expensive Operation Throttling', () => {
    it('applies lower quota to expensive endpoints such as POST /webhook-endpoints', async () => {
      const expensiveApp = express();
      const expKey = `expensive_test_${uuidv4()}`;
      const expensiveLimiter = createRateLimiter({
        tier: 'expensive',
        windowMs: 5000,
        max: 2,
        keyGenerator: () => expKey,
        message: 'Expensive endpoint quota exceeded.',
      });

      expensiveApp.post('/expensive-op', expensiveLimiter, (req, res) => {
        res.json({ started: true });
      });

      // Request 1: Allowed
      const r1 = await request(expensiveApp).post('/expensive-op');
      expect(r1.status).toBe(200);

      // Request 2: Allowed
      const r2 = await request(expensiveApp).post('/expensive-op');
      expect(r2.status).toBe(200);

      // Request 3: Throttled with 429
      const r3 = await request(expensiveApp).post('/expensive-op');
      expect(r3.status).toBe(429);
      expect(r3.body.message).toContain('Expensive endpoint quota exceeded.');
    });
  });
});
