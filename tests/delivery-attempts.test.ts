import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { query } from '../src/db/pool';
import { processOutboxDelivery } from '../src/worker';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_TOKEN = 'default-admin-token-secret-99999';

describe('Delivery Attempts Log & Webhook Replay Suite', () => {
  let timeoutServer: http.Server | null = null;
  let timeoutPort = 49998;

  beforeEach(async () => {
    // Reset crash mode on mock merchant
    await request(app).post('/mock-merchant/crash').send({ crash: false });
  });

  afterAll(async () => {
    if (timeoutServer) {
      await new Promise<void>((resolve) => timeoutServer!.close(() => resolve()));
    }
  });

  describe('Delivery Attempt Recording for 500s, Timeouts, and Connection Refused', () => {
    it('records delivery attempt with http_status 500 and error snippet when endpoint returns 500', async () => {
      const eventId = uuidv4();
      const targetUrl = 'http://127.0.0.1:3000/mock-merchant/webhook';
      const payload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 5000,
      };

      // 1. Insert outbox event in PostgreSQL
      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', $3, $4, 'PENDING', 0)`,
        [eventId, DEMO_MERCHANT_ID, JSON.stringify(payload), targetUrl]
      );

      // 2. Put mock merchant into crash mode (500)
      await request(app).post('/mock-merchant/crash').send({ crash: true });

      // 3. Process delivery attempt 1
      const outcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(outcome.delivered).toBe(false);

      // 4. Query delivery_attempts
      const attemptsResult = await query(
        `SELECT id, outbox_event_id, attempt_number, started_at, duration_ms,
                http_status, error_message, request_signature, next_retry_at
         FROM delivery_attempts
         WHERE outbox_event_id = $1
         ORDER BY attempt_number ASC`,
        [eventId]
      );

      expect(attemptsResult.rows.length).toBe(1);
      const attempt = attemptsResult.rows[0];
      expect(Number(attempt.attempt_number)).toBe(1);
      expect(Number(attempt.http_status)).toBe(500);
      expect(attempt.error_message).toContain('Mock merchant server crashed');
      expect(attempt.error_message.length).toBeLessThanOrEqual(1024);
      expect(attempt.duration_ms).toBeGreaterThanOrEqual(0);
      expect(attempt.request_signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(attempt.next_retry_at).not.toBeNull();
    });

    it('records delivery attempt with null http_status and error snippet on connection refused (ECONNREFUSED)', async () => {
      const eventId = uuidv4();
      // Target an unused localhost port
      const targetUrl = 'http://127.0.0.1:49992/unreachable-webhook';
      const payload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 12000,
      };

      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', $3, $4, 'PENDING', 0)`,
        [eventId, DEMO_MERCHANT_ID, JSON.stringify(payload), targetUrl]
      );

      const outcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(outcome.delivered).toBe(false);

      const attemptsResult = await query(
        `SELECT attempt_number, http_status, error_message, request_signature
         FROM delivery_attempts
         WHERE outbox_event_id = $1`,
        [eventId]
      );

      expect(attemptsResult.rows.length).toBe(1);
      const attempt = attemptsResult.rows[0];
      expect(Number(attempt.attempt_number)).toBe(1);
      expect(attempt.http_status).toBeNull();
      expect(attempt.error_message).toContain('ECONNREFUSED');
      expect(attempt.request_signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    });

    it('records delivery attempt with null http_status and error snippet on request timeout', async () => {
      // Start a temporary HTTP server that never sends a response (hangs)
      timeoutServer = http.createServer((_req, _res) => {
        // Intentionally hang without responding
      });

      await new Promise<void>((resolve) => {
        timeoutServer!.listen(timeoutPort, '127.0.0.1', () => resolve());
      });

      const eventId = uuidv4();
      const targetUrl = `http://127.0.0.1:${timeoutPort}/hanging-webhook`;
      const payload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 8000,
      };

      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', $3, $4, 'PENDING', 0)`,
        [eventId, DEMO_MERCHANT_ID, JSON.stringify(payload), targetUrl]
      );

      const outcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(outcome.delivered).toBe(false);

      const attemptsResult = await query(
        `SELECT attempt_number, http_status, error_message, duration_ms
         FROM delivery_attempts
         WHERE outbox_event_id = $1`,
        [eventId]
      );

      expect(attemptsResult.rows.length).toBe(1);
      const attempt = attemptsResult.rows[0];
      expect(Number(attempt.attempt_number)).toBe(1);
      expect(attempt.http_status).toBeNull();
      expect(attempt.error_message).toMatch(/timeout|timed out/i);
    }, 10000);
  });

  describe('Manual Replay of DEAD_LETTER Event & Merchant Recovery', () => {
    it('replays a dead-lettered event, resets attempts to 0, preserves full history, and reaches DELIVERED after recovery', async () => {
      const eventId = uuidv4();
      const targetUrl = 'http://127.0.0.1:3000/mock-merchant/webhook';
      const payload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 45000,
      };

      // 1. Insert outbox event at attempt 4
      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', $3, $4, 'PENDING', 4)`,
        [eventId, DEMO_MERCHANT_ID, JSON.stringify(payload), targetUrl]
      );

      // 2. Put merchant into crash mode (500)
      await request(app).post('/mock-merchant/crash').send({ crash: true });

      // 3. Process attempt 5 -> transitions to DEAD_LETTER
      const failOutcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 4,
      });

      expect(failOutcome.delivered).toBe(false);
      expect(failOutcome.deadLetter).toBe(true);

      const checkDb = await query(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [eventId]);
      expect(checkDb.rows[0].status).toBe('DEAD_LETTER');
      expect(Number(checkDb.rows[0].attempts)).toBe(5);

      // 4. Verify attempt 5 was logged
      const attemptsPreReplay = await query(
        `SELECT id FROM delivery_attempts WHERE outbox_event_id = $1`,
        [eventId]
      );
      expect(attemptsPreReplay.rows.length).toBe(1);

      // 5. Recover merchant (200 OK)
      await request(app).post('/mock-merchant/crash').send({ crash: false });

      // 6. Call POST /outbox/:id/replay
      const replayRes = await request(app)
        .post(`/outbox/${eventId}/replay`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(replayRes.status).toBe(200);
      expect(replayRes.body.event.status).toBe('PENDING');
      expect(replayRes.body.event.attempts).toBe(0);

      // 7. Deliver replayed event (attempt 0 -> 1)
      const successOutcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(successOutcome.delivered).toBe(true);

      // 8. Verify status is now DELIVERED
      const finalDbCheck = await query(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [eventId]);
      expect(finalDbCheck.rows[0].status).toBe('DELIVERED');
      expect(Number(finalDbCheck.rows[0].attempts)).toBe(1);

      // 9. Verify full delivery history is preserved: 2 attempts logged (1 failed, 1 succeeded)
      const attemptsPostReplay = await query(
        `SELECT attempt_number, http_status, error_message
         FROM delivery_attempts
         WHERE outbox_event_id = $1
         ORDER BY started_at ASC`,
        [eventId]
      );
      expect(attemptsPostReplay.rows.length).toBeGreaterThanOrEqual(2);
      expect(Number(attemptsPostReplay.rows[0].http_status)).toBe(500);
      const lastAttempt = attemptsPostReplay.rows[attemptsPostReplay.rows.length - 1];
      expect(Number(lastAttempt.http_status)).toBe(200);
    });

    it('rejects replay with 400 Bad Request if the event is currently PENDING', async () => {
      const eventId = uuidv4();
      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', '{}', 'http://127.0.0.1:3000/webhook', 'PENDING', 0)`,
        [eventId, DEMO_MERCHANT_ID]
      );

      const res = await request(app)
        .post(`/outbox/${eventId}/replay`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Cannot replay an event that is currently PENDING');
    });
  });

  describe('Multi-Tenancy Isolation for Outbox Inspection & Replay', () => {
    it('returns 404 when attempting to replay or view an event belonging to another merchant', async () => {
      // 1. Create a second merchant
      const merchantRes = await request(app)
        .post('/admin/merchants')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
        .send({ name: 'Foreign Tenant Corp' });
      const foreignMerchantId = merchantRes.body.merchant.id;

      // 2. Insert outbox event for foreign merchant
      const foreignEventId = uuidv4();
      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', '{}', 'http://127.0.0.1:3000/foreign-webhook', 'DEAD_LETTER', 5)`,
        [foreignEventId, foreignMerchantId]
      );

      // 3. Demo merchant attempts to GET /outbox/:id for foreign event -> 404
      const getRes = await request(app)
        .get(`/outbox/${foreignEventId}`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(getRes.status).toBe(404);

      // 4. Demo merchant attempts to POST /outbox/:id/replay for foreign event -> 404
      const replayRes = await request(app)
        .post(`/outbox/${foreignEventId}/replay`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(replayRes.status).toBe(404);
    });
  });

  describe('GET /outbox Filtering & Cursor Pagination', () => {
    it('filters events by status and supports cursor-based pagination', async () => {
      const epRes = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          url: 'http://127.0.0.1:3000/mock-merchant/webhook',
          event_types: ['transfer.completed'],
        });
      const endpointId = epRes.body.id;

      // Seed 5 dead letter events
      for (let i = 0; i < 5; i++) {
        await query(
          `INSERT INTO outbox_events (id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts, created_at)
           VALUES ($1, $2, $3, 'transfer.completed', '{}', 'http://127.0.0.1:3000/webhook', 'DEAD_LETTER', 5, NOW() - ($4 || ' minutes')::INTERVAL)`,
          [uuidv4(), DEMO_MERCHANT_ID, endpointId, `${i * 2}`]
        );
      }

      // Page 1: limit 2
      const page1 = await request(app)
        .get(`/outbox?status=DEAD_LETTER&endpoint_id=${endpointId}&limit=2`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(page1.status).toBe(200);
      expect(page1.body.data.length).toBe(2);
      expect(page1.body.pagination.next_cursor).not.toBeNull();

      // Page 2: with cursor
      const nextCursor = page1.body.pagination.next_cursor;
      const page2 = await request(app)
        .get(`/outbox?status=DEAD_LETTER&endpoint_id=${endpointId}&limit=2&cursor=${nextCursor}`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(page2.status).toBe(200);
      expect(page2.body.data.length).toBe(2);

      // Assert items in page 1 and page 2 are distinct
      const page1Ids = page1.body.data.map((e: any) => e.id);
      const page2Ids = page2.body.data.map((e: any) => e.id);
      for (const id of page2Ids) {
        expect(page1Ids).not.toContain(id);
      }
    });
  });

  describe('POST /outbox/replay-batch', () => {
    it('batch replays all DEAD_LETTER events for a specific endpoint', async () => {
      const epRes = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          url: 'http://127.0.0.1:3000/mock-merchant/webhook',
          event_types: ['transfer.completed'],
        });
      const endpointId = epRes.body.id;

      const eventId1 = uuidv4();
      const eventId2 = uuidv4();

      await query(
        `INSERT INTO outbox_events (id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts)
         VALUES 
           ($1, $3, $4, 'transfer.completed', '{}', 'http://127.0.0.1:3000/webhook', 'DEAD_LETTER', 5),
           ($2, $3, $4, 'transfer.completed', '{}', 'http://127.0.0.1:3000/webhook', 'DEAD_LETTER', 5)`,
        [eventId1, eventId2, DEMO_MERCHANT_ID, endpointId]
      );

      const batchRes = await request(app)
        .post('/outbox/replay-batch')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ endpoint_id: endpointId });

      expect(batchRes.status).toBe(200);
      expect(batchRes.body.replayed_count).toBeGreaterThanOrEqual(2);
      expect(batchRes.body.event_ids).toContain(eventId1);
      expect(batchRes.body.event_ids).toContain(eventId2);

      // Verify status in DB
      const dbCheck = await query(
        `SELECT id, status, attempts FROM outbox_events WHERE id IN ($1, $2)`,
        [eventId1, eventId2]
      );
      expect(dbCheck.rows[0].status).toBe('PENDING');
      expect(Number(dbCheck.rows[0].attempts)).toBe(0);
      expect(dbCheck.rows[1].status).toBe('PENDING');
      expect(Number(dbCheck.rows[1].attempts)).toBe(0);
    });
  });

  describe('Stable event_id and delivery_id in Webhook Payload and Headers', () => {
    it('includes stable event_id and unique delivery_id in both payload and headers for receiver deduplication', async () => {
      const eventId = uuidv4();
      const targetUrl = 'http://127.0.0.1:3000/mock-merchant/webhook';
      const payload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: uuidv4(),
        amount_paise: 9999,
      };

      await query(
        `INSERT INTO outbox_events (id, merchant_id, event_type, payload, target_url, status, attempts)
         VALUES ($1, $2, 'transfer.completed', $3, $4, 'PENDING', 0)`,
        [eventId, DEMO_MERCHANT_ID, JSON.stringify(payload), targetUrl]
      );

      const outcome = await processOutboxDelivery({
        eventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload,
        attempts: 0,
      });

      expect(outcome.delivered).toBe(true);

      // Query mock merchant received status
      const merchantStatus = await request(app).get('/mock-merchant/status');
      const received = merchantStatus.body.receivedEvents.find(
        (e: any) => e.payload?.event_id === eventId
      );

      expect(received).toBeDefined();
      expect(received.payload.event_id).toBe(eventId);
      expect(received.payload.delivery_id).toBeDefined();
      expect(received.headers['x-ledgerflow-event-id']).toBe(eventId);
      expect(received.headers['x-ledgerflow-delivery-id']).toBeDefined();
    });
  });
});
