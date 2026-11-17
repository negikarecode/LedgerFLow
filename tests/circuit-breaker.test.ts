import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { query } from '../src/db/pool';
import { redis } from '../src/redis/client';
import {
  circuitBreaker,
  rateLimiter,
  processOutboxDelivery,
  WebhookDeliveryPayload,
  EndpointCircuitBreaker,
  EndpointRateLimiter,
} from '../src/worker';

describe('Per-Endpoint Circuit Breaker & Rate Limiter Suite', () => {
  let merchantId: string;
  let apiKey: string;
  let endpointAId: string;
  let endpointBId: string;

  let serverA: http.Server;
  let portA: number;
  let serverB: http.Server;
  let portB: number;
  let shouldFailA = true;

  let endpointAUrl: string;
  let endpointBUrl: string;

  beforeAll(async () => {
    // 1. Start dedicated isolated mock HTTP servers for Endpoint A and Endpoint B
    serverA = http.createServer((req, res) => {
      if (shouldFailA) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint A simulated failure' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success' }));
      }
    });

    serverB = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success' }));
    });

    await new Promise<void>((resolve) =>
      serverA.listen(0, '127.0.0.1', () => {
        portA = (serverA.address() as any).port;
        endpointAUrl = `http://127.0.0.1:${portA}/webhook`;
        resolve();
      })
    );

    await new Promise<void>((resolve) =>
      serverB.listen(0, '127.0.0.1', () => {
        portB = (serverB.address() as any).port;
        endpointBUrl = `http://127.0.0.1:${portB}/webhook`;
        resolve();
      })
    );

    // 2. Create dedicated test merchant and API key
    const adminRes = await request(app)
      .post('/admin/merchants')
      .set('Authorization', 'Bearer default-admin-token-secret-99999')
      .send({ name: 'Circuit Breaker Isolation Test Merchant' });

    merchantId = adminRes.body.merchant.id;
    apiKey = adminRes.body.api_key.key;
  });

  afterAll(async () => {
    if (serverA) serverA.close();
    if (serverB) serverB.close();
    if (merchantId) {
      await query('DELETE FROM merchants WHERE id = $1', [merchantId]);
    }
  });

  beforeEach(async () => {
    shouldFailA = true;

    endpointAId = uuidv4();
    await query(
      `INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
       VALUES ($1, $2, $3, 'whsec_endpoint_a_secret', ARRAY['transfer.completed'], 'ACTIVE')`,
      [endpointAId, merchantId, endpointAUrl]
    );

    endpointBId = uuidv4();
    await query(
      `INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
       VALUES ($1, $2, $3, 'whsec_endpoint_b_secret', ARRAY['transfer.completed'], 'ACTIVE')`,
      [endpointBId, merchantId, endpointBUrl]
    );

    await circuitBreaker.reset(endpointAId);
    await circuitBreaker.reset(endpointBId);
    await rateLimiter.reset(endpointAId);
    await rateLimiter.reset(endpointBId);
  });

  it('Endpoint A failing 10 times opens its breaker while Endpoint B keeps delivering', async () => {
    // 1. Deliver 10 consecutive failures to Endpoint A
    shouldFailA = true;

    for (let i = 0; i < 10; i++) {
      const eventId = uuidv4();
      await query(
        `INSERT INTO outbox_events (id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, $3, 'transfer.completed', $4, $5, 'PENDING', 0)`,
        [eventId, merchantId, endpointAId, JSON.stringify({ transfer_id: uuidv4() }), endpointAUrl]
      );

      const deliveryPayload: WebhookDeliveryPayload = {
        eventId,
        eventType: 'transfer.completed',
        targetUrl: endpointAUrl,
        payload: { transfer_id: uuidv4() },
        attempts: 0,
        secret: 'whsec_endpoint_a_secret',
        endpointId: endpointAId,
      };

      const result = await processOutboxDelivery(deliveryPayload);
      expect(result.delivered).toBe(false);
    }

    // 2. Verify Endpoint A circuit breaker is now OPEN
    const statusA = await circuitBreaker.getStatus(endpointAId);
    expect(statusA.state).toBe('OPEN');
    expect(statusA.consecutive_failures).toBeGreaterThanOrEqual(10);
    expect(statusA.opened_at).not.toBeNull();
    expect(statusA.cooldown_remaining_seconds).toBeGreaterThan(0);

    // 3. Test that subsequent job to Endpoint A is NOT sent over network, does NOT burn an attempt,
    // and is rescheduled with delay
    const eventA11 = uuidv4();
    await query(
      `INSERT INTO outbox_events (id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, $3, 'transfer.completed', $4, $5, 'PENDING', 0)`,
      [eventA11, merchantId, endpointAId, JSON.stringify({ transfer_id: uuidv4() }), endpointAUrl]
    );

    const deliveryPayloadA11: WebhookDeliveryPayload = {
      eventId: eventA11,
      eventType: 'transfer.completed',
      targetUrl: endpointAUrl,
      payload: { transfer_id: uuidv4() },
      attempts: 0,
      secret: 'whsec_endpoint_a_secret',
      endpointId: endpointAId,
    };

    const resA11 = await processOutboxDelivery(deliveryPayloadA11);
    expect(resA11.delivered).toBe(false);
    expect(resA11.rescheduled).toBe(true);
    expect(resA11.reason).toBe('CIRCUIT_BREAKER_OPEN');
    expect(resA11.delayMs).toBeGreaterThan(0);

    // Assert database record was NOT incremented (attempts remains 0)
    const dbEventA11 = await query(`SELECT attempts, status FROM outbox_events WHERE id = $1`, [eventA11]);
    expect(Number(dbEventA11.rows[0].attempts)).toBe(0);
    expect(dbEventA11.rows[0].status).toBe('PENDING');

    // 4. Meanwhile, Endpoint B delivers to healthy receiver with zero interference
    const eventB1 = uuidv4();
    await query(
      `INSERT INTO outbox_events (id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts)
       VALUES ($1, $2, $3, 'transfer.completed', $4, $5, 'PENDING', 0)`,
      [eventB1, merchantId, endpointBId, JSON.stringify({ transfer_id: uuidv4() }), endpointBUrl]
    );

    const deliveryPayloadB1: WebhookDeliveryPayload = {
      eventId: eventB1,
      eventType: 'transfer.completed',
      targetUrl: endpointBUrl,
      payload: { transfer_id: uuidv4() },
      attempts: 0,
      secret: 'whsec_endpoint_b_secret',
      endpointId: endpointBId,
    };

    const resB1 = await processOutboxDelivery(deliveryPayloadB1);
    expect(resB1.delivered).toBe(true);

    const statusB = await circuitBreaker.getStatus(endpointBId);
    expect(statusB.state).toBe('CLOSED');
    expect(statusB.consecutive_failures).toBe(0);
  });

  it('Circuit breaker recovers via HALF_OPEN probe when endpoint recovers', async () => {
    // 1. Create breaker with 1-second cooldown
    const fastBreaker = new EndpointCircuitBreaker({
      consecutiveFailuresThreshold: 3,
      cooldownSeconds: 1,
    });

    // 2. Trip breaker on Endpoint A by recording 3 failures
    await fastBreaker.recordFailure(endpointAId);
    await fastBreaker.recordFailure(endpointAId);
    const tripResult = await fastBreaker.recordFailure(endpointAId);
    expect(tripResult.tripped).toBe(true);

    // Confirm it is OPEN
    const openCheck = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(openCheck.allowed).toBe(false);
    expect(openCheck.state).toBe('OPEN');

    // 3. Wait for the 1-second cooldown to elapse
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // 4. Breaker transitions to HALF_OPEN and permits a single probe request
    const probeCheck1 = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(probeCheck1.allowed).toBe(true);
    expect(probeCheck1.state).toBe('HALF_OPEN');
    expect(probeCheck1.isProbe).toBe(true);

    // Concurrent second request while probe is in flight is rejected/delayed
    const probeCheck2 = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(probeCheck2.allowed).toBe(false);
    expect(probeCheck2.state).toBe('HALF_OPEN');

    // 5. The probe succeeds -> breaker transitions to CLOSED
    await fastBreaker.recordSuccess(endpointAId, true);

    const closedCheck = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(closedCheck.allowed).toBe(true);
    expect(closedCheck.state).toBe('CLOSED');

    const finalStatus = await fastBreaker.getStatus(endpointAId);
    expect(finalStatus.state).toBe('CLOSED');
    expect(finalStatus.consecutive_failures).toBe(0);
  });

  it('HALF_OPEN probe failure immediately re-trips breaker to OPEN', async () => {
    const fastBreaker = new EndpointCircuitBreaker({
      consecutiveFailuresThreshold: 2,
      cooldownSeconds: 1,
    });

    await fastBreaker.recordFailure(endpointAId);
    await fastBreaker.recordFailure(endpointAId);

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Acquire probe
    const probeCheck = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(probeCheck.isProbe).toBe(true);

    // Probe fails!
    const failResult = await fastBreaker.recordFailure(endpointAId, true);
    expect(failResult.tripped).toBe(true);

    const recheck = await fastBreaker.canAttemptDelivery(endpointAId);
    expect(recheck.allowed).toBe(false);
    expect(recheck.state).toBe('OPEN');
  });

  it('Token bucket rate limiter caps deliveries and delays excess without dropping', async () => {
    const strictRateLimiter = new EndpointRateLimiter({
      deliveriesPerSecond: 2,
      burstCapacity: 3,
    });

    await strictRateLimiter.reset(endpointAId);

    // Consume burst of 3 tokens
    const r1 = await strictRateLimiter.consume(endpointAId, 2, 3);
    const r2 = await strictRateLimiter.consume(endpointAId, 2, 3);
    const r3 = await strictRateLimiter.consume(endpointAId, 2, 3);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);

    // 4th immediate request exceeds capacity and must be delayed
    const r4 = await strictRateLimiter.consume(endpointAId, 2, 3);
    expect(r4.allowed).toBe(false);
    expect(r4.waitMs).toBeGreaterThan(0);

    // Wait until at least 1 token refills (600ms for 2 tokens/sec)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Request is now allowed
    const r5 = await strictRateLimiter.consume(endpointAId, 2, 3);
    expect(r5.allowed).toBe(true);
  });

  it('Exposes circuit breaker state in GET /webhook-endpoints/:id', async () => {
    // Trip Endpoint A
    for (let i = 0; i < 10; i++) {
      await circuitBreaker.recordFailure(endpointAId);
    }

    const res = await request(app)
      .get(`/webhook-endpoints/${endpointAId}`)
      .set('Authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(endpointAId);
    expect(res.body.circuit_breaker).toBeDefined();
    expect(res.body.circuit_breaker.state).toBe('OPEN');
    expect(res.body.circuit_breaker.consecutive_failures).toBeGreaterThanOrEqual(10);
    expect(res.body.circuit_breaker.cooldown_remaining_seconds).toBeGreaterThan(0);
    expect(res.body.rate_limit).toBeDefined();
    expect(res.body.rate_limit.deliveries_per_second).toBeGreaterThan(0);

    // Cross-tenant access on another merchant returns 404
    const adminRes = await request(app)
      .post('/admin/merchants')
      .set('Authorization', 'Bearer default-admin-token-secret-99999')
      .send({ name: 'Foreign Merchant' });
    const foreignApiKey = adminRes.body.api_key.key;

    const foreignRes = await request(app)
      .get(`/webhook-endpoints/${endpointAId}`)
      .set('Authorization', `Bearer ${foreignApiKey}`);
    expect(foreignRes.status).toBe(404);

    await query('DELETE FROM merchants WHERE id = $1', [adminRes.body.merchant.id]);
  });

  it('Falls back safely to PostgreSQL if Redis is degraded or down', async () => {
    await query(
      `UPDATE webhook_endpoints 
       SET circuit_breaker_state = 'OPEN', consecutive_failures = 12, cb_opened_at = NOW() 
       WHERE id = $1`,
      [endpointAId]
    );

    const customBreaker = new EndpointCircuitBreaker({ cooldownSeconds: 60 });
    await redis.del(`cb:endpoint:${endpointAId}`);

    const status = await (customBreaker as any).getStatusPostgresFallback(endpointAId);
    expect(status.state).toBe('OPEN');
    expect(status.consecutive_failures).toBe(12);
    expect(status.cooldown_remaining_seconds).toBeGreaterThan(0);

    await query(
      `UPDATE webhook_endpoints 
       SET circuit_breaker_state = 'CLOSED', consecutive_failures = 0, cb_opened_at = NULL 
       WHERE id = $1`,
      [endpointAId]
    );
  });
});
