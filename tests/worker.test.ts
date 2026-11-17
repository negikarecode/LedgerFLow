import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, query, closePool } from '../src/db/pool';
import { redis, closeRedis } from '../src/redis/client';
import { env } from '../src/config/env';
import { signPayload, verifySignature } from '../src/worker/signature';
import { processOutboxDelivery } from '../src/worker/index';

describe('LedgerFlow Phase 3 - Webhook Worker & Mock Merchant Suite', () => {
  beforeEach(async () => {
    // Reset mock merchant state
    await request(app).post('/mock-merchant/reset');
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('HMAC-SHA256 Signature Verification', () => {
    const secret = 'test-secret-key-xyz';
    const payload = JSON.stringify({
      event: 'transfer.completed',
      transaction_id: uuidv4(),
      amount_paise: 50000,
    });

    it('should generate signature header in format t=<timestamp>,v1=<hex>', () => {
      const fixedTs = 1700000000;
      const res = signPayload(payload, secret, fixedTs);

      expect(res.timestamp).toBe(fixedTs);
      expect(res.signatureHeader).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(res.signatureHeader).toContain(`t=${fixedTs}`);
    });

    it('should successfully verify valid signature matching payload and secret', () => {
      const signed = signPayload(payload, secret);
      const verification = verifySignature(payload, signed.signatureHeader, secret);

      expect(verification.valid).toBe(true);
      expect(verification.timestamp).toBe(signed.timestamp);
    });

    it('should reject signature when payload has been tampered with', () => {
      const signed = signPayload(payload, secret);
      const tamperedPayload = JSON.stringify({
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 999999, // Tampered!
      });

      const verification = verifySignature(tamperedPayload, signed.signatureHeader, secret);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });

    it('should reject signature when secret is incorrect', () => {
      const signed = signPayload(payload, secret);
      const verification = verifySignature(payload, signed.signatureHeader, 'wrong-secret');

      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });

    it('should reject malformed or missing signature headers', () => {
      expect(verifySignature(payload, '', secret).valid).toBe(false);
      expect(verifySignature(payload, 'garbage', secret).valid).toBe(false);
      expect(verifySignature(payload, 't=123', secret).valid).toBe(false);
    });

    it('should enforce signature verification on POST /mock-merchant/webhook (401 on invalid/missing)', async () => {
      const body = { event: 'test.webhook' };

      // Missing header
      const resMissing = await request(app)
        .post('/mock-merchant/webhook')
        .send(body);
      expect(resMissing.status).toBe(401);
      expect(resMissing.body.error).toBe('Unauthorized');

      // Valid header using env.WEBHOOK_SECRET
      const signed = signPayload(JSON.stringify(body), env.WEBHOOK_SECRET);
      const resValid = await request(app)
        .post('/mock-merchant/webhook')
        .set('X-LedgerFlow-Signature', signed.signatureHeader)
        .send(body);
      expect(resValid.status).toBe(200);
      expect(resValid.body.received).toBe(true);
    });
  });

  describe('Retry -> Recovery Pipeline', () => {
    it('should retry on merchant 500 (crash mode ON), then recover to DELIVERED on merchant 200 (crash mode OFF)', async () => {
      // 1. Create target outbox event in PostgreSQL
      const eventId = uuidv4();
      const targetUrl = 'http://127.0.0.1:3000/mock-merchant/webhook';
      const payload = {
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 30000,
      };

      await query(
        `INSERT INTO outbox_events (id, event_type, payload, target_url, status, attempts)
         VALUES ($1, 'transfer.completed', $2, $3, 'PENDING', 0)`,
        [eventId, JSON.stringify(payload), targetUrl]
      );

      // 2. Set merchant Crash Mode ON
      const crashRes = await request(app)
        .post('/mock-merchant/crash')
        .send({ crash: true });
      expect(crashRes.status).toBe(200);
      expect(crashRes.body.crashMode).toBe(true);

      // 3. Process delivery (attempt 1 -> fails with 500)
      const deliveryAttempt1 = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(deliveryAttempt1.delivered).toBe(false);
      expect(deliveryAttempt1.deadLetter).toBe(false);

      // Verify PostgreSQL state after attempt 1
      const dbAfter1 = await query(
        `SELECT status, attempts, next_retry_at FROM outbox_events WHERE id = $1`,
        [eventId]
      );
      expect(dbAfter1.rows[0].status).toBe('PENDING');
      expect(Number(dbAfter1.rows[0].attempts)).toBe(1);
      expect(dbAfter1.rows[0].next_retry_at).not.toBeNull();

      // 4. Recover merchant by setting Crash Mode OFF
      const recoverRes = await request(app)
        .post('/mock-merchant/crash')
        .send({ crash: false });
      expect(recoverRes.status).toBe(200);
      expect(recoverRes.body.crashMode).toBe(false);

      // 5. Process delivery again (attempt 2 -> succeeds with 200)
      const deliveryAttempt2 = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 1,
      });

      expect(deliveryAttempt2.delivered).toBe(true);

      // Verify PostgreSQL state after recovery
      const dbAfter2 = await query(
        `SELECT status, attempts, next_retry_at FROM outbox_events WHERE id = $1`,
        [eventId]
      );
      expect(dbAfter2.rows[0].status).toBe('DELIVERED');
      expect(dbAfter2.rows[0].next_retry_at).toBeNull();

      // Verify mock merchant recorded the event
      const merchantStatus = await request(app).get('/mock-merchant/status');
      expect(merchantStatus.status).toBe(200);
      expect(merchantStatus.body.receivedEvents.length).toBeGreaterThanOrEqual(1);
      const matchingEvent = merchantStatus.body.receivedEvents.find(
        (e: any) => e.payload?.transaction_id === payload.transaction_id
      );
      expect(matchingEvent).toBeDefined();
      expect(matchingEvent.payload.transaction_id).toBe(payload.transaction_id);
    });
  });

  describe('Max Retries -> DEAD_LETTER -> Replay -> DELIVERED', () => {
    it('should transition to DEAD_LETTER after 5 failed attempts, allow replay back to PENDING, and recover to DELIVERED', async () => {
      const eventId = uuidv4();
      const targetUrl = 'http://127.0.0.1:3000/mock-merchant/webhook';
      const payload = {
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 75000,
      };

      // 1. Insert outbox event at attempt 4
      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, '00000000-0000-0000-0000-000000000001', 'transfer.completed', $2, $3, 'PENDING', 4)`,
        [eventId, JSON.stringify(payload), targetUrl]
      );

      // 2. Enable crash mode on mock merchant
      await request(app).post('/mock-merchant/crash').send({ crash: true });

      // 3. Process 5th delivery attempt
      const attempt5 = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 4,
      });

      expect(attempt5.delivered).toBe(false);
      expect(attempt5.deadLetter).toBe(true);

      // Verify PostgreSQL marks it DEAD_LETTER
      const deadLetterCheck = await query(
        `SELECT status, attempts, next_retry_at FROM outbox_events WHERE id = $1`,
        [eventId]
      );
      expect(deadLetterCheck.rows[0].status).toBe('DEAD_LETTER');
      expect(Number(deadLetterCheck.rows[0].attempts)).toBe(5);

      // 4. Call POST /outbox/:id/replay to reset event
      const replayRes = await request(app)
        .post(`/outbox/${eventId}/replay`)
        .set('Authorization', 'Bearer lf_live_demo_key_for_chaos_simulator_1234567890');
      expect(replayRes.status).toBe(200);
      expect(replayRes.body.event.status).toBe('PENDING');
      expect(replayRes.body.event.attempts).toBe(0);

      const dbAfterReplay = await query(
        `SELECT status, attempts, next_retry_at FROM outbox_events WHERE id = $1`,
        [eventId]
      );
      expect(dbAfterReplay.rows[0].status).toBe('PENDING');
      expect(Number(dbAfterReplay.rows[0].attempts)).toBe(0);

      // 5. Disable crash mode so delivery will succeed
      await request(app).post('/mock-merchant/crash').send({ crash: false });

      // 6. Deliver replayed event
      const replayedDelivery = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(replayedDelivery.delivered).toBe(true);

      // Final state must be DELIVERED
      const finalDbCheck = await query(
        `SELECT status FROM outbox_events WHERE id = $1`,
        [eventId]
      );
      expect(finalDbCheck.rows[0].status).toBe('DELIVERED');
    });

    it('should return 404 when attempting to replay non-existent outbox event', async () => {
      const nonExistentId = uuidv4();
      const res = await request(app)
        .post(`/outbox/${nonExistentId}/replay`)
        .set('Authorization', 'Bearer lf_live_demo_key_for_chaos_simulator_1234567890');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });
  });

  describe('Chaos Simulator UI Loading', () => {
    it('should serve the Chaos Simulator UI at GET / with 200 OK and valid HTML', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('LedgerFlow');
      expect(res.text).toContain('Chaos Simulator');
      expect(res.text).toContain('Accounts & Ledger');
      expect(res.text).toContain('Mock Merchant Receiver');
      expect(res.text).toContain('Transactional Outbox & Worker Retries');
      expect(res.text).toContain('Simulate 20x Double-Tap');
      expect(res.text).toContain('Simulate 20x Race Condition');
    });
  });
});
