import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { processOutboxDelivery } from '../src/worker';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('LedgerFlow Observability & Metrics Suite', () => {
  let aliceId: string;
  let bobId: string;
  let receiverServer: http.Server;
  let receiverPort: number;
  let receivedHeaders: Record<string, any> = {};

  beforeAll(async () => {
    // Start hermetic local webhook receiver
    receiverServer = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK' }));
    });

    await new Promise<void>((resolve) => {
      receiverServer.listen(0, '127.0.0.1', () => {
        receiverPort = (receiverServer.address() as any).port;
        resolve();
      });
    });

    // Seed test accounts for DEMO_MERCHANT
    aliceId = uuidv4();
    bobId = uuidv4();

    await pool.query(
      `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise) 
       VALUES ($1, $2, $3, $4, 50000), ($5, $2, $6, $4, 0)
       ON CONFLICT (id) DO NOTHING`,
      [aliceId, DEMO_MERCHANT_ID, 'Alice Metric', 'INR', bobId, 'Bob Metric']
    );

    // Give Alice 50,000 paise
    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, $3, 'CREDIT', 50000)`,
      [uuidv4(), uuidv4(), aliceId]
    );
  });

  afterAll(async () => {
    if (receiverServer) {
      await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    }
    await closePool();
    await closeRedis();
  });

  describe('Prometheus Metrics (GET /metrics)', () => {
    it('should be publicly accessible without authentication', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('should expose all 9 required business and system metrics', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      const text = res.text;

      // 1. HTTP Request Duration Histogram
      expect(text).toContain('http_request_duration_seconds');
      // 2. Transfers Total Counter
      expect(text).toContain('transfers_total');
      // 3. Idempotency Replays Counter
      expect(text).toContain('idempotency_replays_total');
      // 4. Outbox Queue Depth Gauge
      expect(text).toContain('outbox_queue_depth');
      // 5. Webhook Delivery Duration Histogram
      expect(text).toContain('webhook_delivery_duration_seconds');
      // 6. Webhook Deliveries Total Counter
      expect(text).toContain('webhook_deliveries_total');
      // 7. Circuit Breaker State Gauge
      expect(text).toContain('circuit_breaker_state');
      // 8. Database Pool Connections Gauge
      expect(text).toContain('db_pool_connections');
      // 9. Double-Entry Ledger Conservation Discrepancy Gauge
      expect(text).toContain('ledger_conservation_discrepancy_paise');
    });

    it('should maintain double-entry ledger conservation invariant at exactly 0 paise', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      // Ensure discrepancy gauge is reported as 0
      expect(res.text).toMatch(/ledger_conservation_discrepancy_paise 0/);
    });
  });

  describe('Request ID & Distributed Tracing', () => {
    it('should generate an X-Request-Id header if none is provided', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
    });

    it('should propagate incoming X-Request-Id to the response header', async () => {
      const customRequestId = 'trace-client-req-' + uuidv4();
      const res = await request(app)
        .get('/health')
        .set('X-Request-Id', customRequestId);

      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe(customRequestId);
    });

    it('should propagate request ID from transfer API to outbox_events and delivery_attempts', async () => {
      // 1. Register an active webhook endpoint targeting our receiver
      const endpointRes = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          url: `http://127.0.0.1:${receiverPort}/webhook`,
          event_types: ['transfer.completed'],
        });
      expect(endpointRes.status).toBe(201);
      const endpointId = endpointRes.body.id;

      // 2. Perform transfer with custom X-Request-Id
      const customTraceId = 'e2e-trace-' + uuidv4();
      const transferRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .set('X-Request-Id', customTraceId)
        .send({
          from_account_id: aliceId,
          to_account_id: bobId,
          amount_paise: 500,
        });

      expect(transferRes.status).toBe(201);
      expect(transferRes.headers['x-request-id']).toBe(customTraceId);

      const outboxEventId = transferRes.body.outbox_event_id;
      expect(outboxEventId).toBeDefined();

      // 3. Verify outbox_events stored the request_id
      const outboxRow = await pool.query(
        `SELECT request_id, payload FROM outbox_events WHERE id = $1`,
        [outboxEventId]
      );
      expect(outboxRow.rows.length).toBe(1);
      expect(outboxRow.rows[0].request_id).toBe(customTraceId);
      expect(outboxRow.rows[0].payload.request_id).toBe(customTraceId);

      // 4. Execute delivery attempt via worker function
      const deliveryResult = await processOutboxDelivery({
        eventId: outboxEventId,
        eventType: 'transfer.completed',
        targetUrl: `http://127.0.0.1:${receiverPort}/webhook`,
        payload: outboxRow.rows[0].payload,
        attempts: 0,
        endpointId,
        requestId: customTraceId,
      });

      expect(deliveryResult.delivered).toBe(true);

      // 5. Verify the HTTP receiver received the X-Request-Id header!
      expect(receivedHeaders['x-request-id']).toBe(customTraceId);

      // 6. Verify delivery_attempts table captured the propagated request_id
      const attemptRow = await pool.query(
        `SELECT request_id, http_status FROM delivery_attempts WHERE outbox_event_id = $1`,
        [outboxEventId]
      );
      expect(attemptRow.rows.length).toBeGreaterThanOrEqual(1);
      expect(attemptRow.rows[0].request_id).toBe(customTraceId);
      expect(attemptRow.rows[0].http_status).toBe(200);

      // Clean up endpoint
      await pool.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [endpointId]);
    });
  });

  describe('Outcome Metrics Accounting', () => {
    it('should increment idempotency_replays_total and transfers_total on cached replay', async () => {
      const idempotencyKey = 'replay-metric-test-' + uuidv4();

      // First request
      const firstRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: aliceId,
          to_account_id: bobId,
          amount_paise: 100,
        });
      expect(firstRes.status).toBe(201);

      // Replay request
      const replayRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: aliceId,
          to_account_id: bobId,
          amount_paise: 100,
        });
      expect(replayRes.status).toBe(201);
      expect(replayRes.headers['x-idempotent-replay']).toBe('true');

      // Check metrics
      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).toContain('idempotency_replays_total');
      expect(metricsRes.text).toContain('transfers_total{outcome="replay"}');
    });
  });
});
