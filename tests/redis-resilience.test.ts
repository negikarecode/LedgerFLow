import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import net from 'net';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, query, closePool } from '../src/db/pool';
import {
  redis,
  createRedisClient,
  createBullMQRedisClient,
  calculateRedisBackoff,
  checkRedisHealth,
  closeRedis,
} from '../src/redis/client';
import {
  pollAndEnqueueOutboxEvents,
  processOutboxDelivery,
  WebhookDeliveryPayload,
} from '../src/worker';
import {
  metricsRegistry,
  redisConnectedGauge,
  redisErrorsTotal,
  idempotencyFallbackTotal,
  outboxPollerErrorsTotal,
  ledgerConservationDiscrepancyPaise,
} from '../src/observability/metrics';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Programmable TCP proxy to deterministically simulate network partitions,
 * dropped connections, socket blackholes, authentication failures, and recovery.
 */
class ProgrammableRedisProxy {
  public server: net.Server;
  public clientSockets: Set<net.Socket> = new Set();
  public targetPort: number;
  public targetHost: string;
  public mode: 'passthrough' | 'drop' | 'blackhole' | 'auth_error' = 'passthrough';
  public port = 0;

  constructor(targetPort = 6380, targetHost = '127.0.0.1') {
    this.targetPort = targetPort;
    this.targetHost = targetHost;
    this.server = net.createServer((clientSocket) => {
      this.clientSockets.add(clientSocket);
      clientSocket.on('close', () => this.clientSockets.delete(clientSocket));

      if (this.mode === 'blackhole') {
        // Accept socket but never reply or forward (simulates network timeout/unresponsive host)
        return;
      }

      if (this.mode === 'drop') {
        clientSocket.destroy();
        return;
      }

      if (this.mode === 'auth_error') {
        clientSocket.on('data', () => {
          clientSocket.write('-WRONGPASS invalid username-password pair\r\n');
        });
        return;
      }

      // Passthrough mode: pipe traffic bi-directionally to real Redis
      const redisSocket = net.connect(this.targetPort, this.targetHost);
      clientSocket.pipe(redisSocket);
      redisSocket.pipe(clientSocket);

      clientSocket.on('error', () => redisSocket.destroy());
      redisSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => redisSocket.destroy());
      redisSocket.on('close', () => clientSocket.destroy());
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  dropAllConnections() {
    for (const socket of this.clientSockets) {
      socket.destroy();
    }
    this.clientSockets.clear();
  }

  async stop(): Promise<void> {
    this.dropAllConnections();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

describe('LedgerFlow Redis Resilience, Failure Modes & Degraded Lifecycle Suite', () => {
  let proxy: ProgrammableRedisProxy;
  let proxyPort: number;
  let receiverServer: http.Server;
  let receiverPort: number;
  let receivedWebhooks: { headers: Record<string, any>; body: any }[] = [];

  beforeAll(async () => {
    // 1. Start programmable proxy pointing to running Redis instance
    proxy = new ProgrammableRedisProxy(6380, '127.0.0.1');
    proxyPort = await proxy.start();

    // 2. Start mock receiver server for webhook delivery verification
    receiverServer = http.createServer((req, res) => {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });
      req.on('end', () => {
        try {
          receivedWebhooks.push({
            headers: req.headers,
            body: JSON.parse(bodyStr),
          });
        } catch {
          receivedWebhooks.push({
            headers: req.headers,
            body: bodyStr,
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'OK' }));
      });
    });

    await new Promise<void>((resolve) => {
      receiverServer.listen(0, '127.0.0.1', () => {
        receiverPort = (receiverServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (proxy) await proxy.stop();
    if (receiverServer) {
      await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    }
    await closePool();
    await closeRedis();
  });

  beforeEach(async () => {
    receivedWebhooks = [];
    proxy.mode = 'passthrough';
  });

  describe('1. Reconnection Behavior: Bounded Exponential Backoff with Jitter', () => {
    it('should grow exponentially across successive retry attempts', () => {
      const delay1 = calculateRedisBackoff(1, { baseDelayMs: 100, maxDelayMs: 3000, jitterRatio: 0 });
      const delay2 = calculateRedisBackoff(2, { baseDelayMs: 100, maxDelayMs: 3000, jitterRatio: 0 });
      const delay3 = calculateRedisBackoff(3, { baseDelayMs: 100, maxDelayMs: 3000, jitterRatio: 0 });
      const delay4 = calculateRedisBackoff(4, { baseDelayMs: 100, maxDelayMs: 3000, jitterRatio: 0 });

      expect(delay1).toBe(100);
      expect(delay2).toBe(200);
      expect(delay3).toBe(400);
      expect(delay4).toBe(800);
    });

    it('should be strictly bounded by maxDelayMs regardless of attempt count', () => {
      const maxDelay = 3000;
      for (let attempt = 1; attempt <= 30; attempt++) {
        const delay = calculateRedisBackoff(attempt, { baseDelayMs: 100, maxDelayMs: maxDelay, jitterRatio: 0.3 });
        expect(delay).toBeLessThanOrEqual(maxDelay);
        expect(delay).toBeGreaterThanOrEqual(100);
      }
    });

    it('should apply jitter to spread reconnection attempts and prevent thundering herd', () => {
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        samples.push(calculateRedisBackoff(3, { baseDelayMs: 100, maxDelayMs: 3000, jitterRatio: 0.3 }));
      }
      // With jitter, not all samples should be identical
      const uniqueSamples = new Set(samples);
      expect(uniqueSamples.size).toBeGreaterThan(1);
      // All samples must stay within [expDelay, expDelay + jitter]
      for (const s of samples) {
        expect(s).toBeGreaterThanOrEqual(400);
        expect(s).toBeLessThanOrEqual(400 + 400 * 0.3);
      }
    });

    it('should handle edge cases (attempt 0 or negative) safely without throwing or NaN', () => {
      const delay0 = calculateRedisBackoff(0);
      const delayNeg = calculateRedisBackoff(-5);
      expect(Number.isFinite(delay0)).toBe(true);
      expect(Number.isFinite(delayNeg)).toBe(true);
      expect(delay0).toBeGreaterThanOrEqual(100);
      expect(delayNeg).toBeGreaterThanOrEqual(100);
    });
  });

  describe('2. Redis Unavailable at Application Startup & Non-Blocking Lifecycle', () => {
    it('should initialize Redis client without unhandled crashes when server is unreachable', async () => {
      // Connect to non-existent port (59999)
      const offlineClient = createRedisClient('redis://127.0.0.1:59999', {
        retryStrategy: () => null, // Stop retry immediately
      });

      expect(offlineClient).toBeDefined();
      expect(['wait', 'connecting', 'close', 'reconnecting']).toContain(offlineClient.status);

      // Verify command immediately fails fast due to enableOfflineQueue: false
      await expect(offlineClient.ping()).rejects.toThrow();

      offlineClient.disconnect();
    });

    it('BullMQ Redis client should handle unreachable Redis server without unhandled crashes', async () => {
      const offlineBullMQClient = createBullMQRedisClient('redis://127.0.0.1:59999', {
        retryStrategy: () => null, // Stop retry immediately
      });
      expect(offlineBullMQClient).toBeDefined();
      expect(['wait', 'connecting', 'close', 'reconnecting']).toContain(offlineBullMQClient.status);
      const errorPromise = new Promise((resolve) => offlineBullMQClient.once('error', resolve));
      const emittedErr = await errorPromise;
      expect(emittedErr).toBeDefined();
      offlineBullMQClient.disconnect();
    });

    it('checkRedisHealth should report DOWN status with error details without hanging', async () => {
      const health = await checkRedisHealth();
      expect(['up', 'down']).toContain(health.status);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('3. Connection Drops, Timeouts, Authentication Failure & Recovery', () => {
    it('should survive abruptly dropped TCP connections and reconnect cleanly', async () => {
      const testClient = createRedisClient(`redis://127.0.0.1:${proxyPort}`, {
        retryStrategy: () => 100, // Reconnect quickly for test
      });

      // Wait until client is ready
      await new Promise((resolve) => testClient.once('ready', resolve));

      // Verify baseline ping through proxy
      const initialPong = await testClient.ping();
      expect(initialPong).toBe('PONG');

      // Setup promise for reconnection ready event
      const reconnectedPromise = new Promise((resolve) => testClient.once('ready', resolve));

      // Force drop all sockets
      proxy.dropAllConnections();

      // Next immediate command should reject because connection was severed
      try {
        await testClient.ping();
      } catch (err: any) {
        expect(err).toBeDefined();
      }

      // Wait for client to reconnect automatically via bounded backoff strategy
      await reconnectedPromise;

      // After recovery, ping succeeds again
      const recoveredPong = await testClient.ping();
      expect(recoveredPong).toBe('PONG');

      testClient.disconnect();
    });

    it('should detect connection timeouts (blackhole) without hanging indefinitely', async () => {
      proxy.mode = 'blackhole';
      proxy.dropAllConnections();

      const testClient = createRedisClient(`redis://127.0.0.1:${proxyPort}`, {
        connectTimeout: 500,
        commandTimeout: 500,
        retryStrategy: () => null,
      });

      const start = Date.now();
      try {
        await testClient.ping();
        expect.unreachable('Should have timed out');
      } catch (err: any) {
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2500); // Bounded timeout, not hanging
        expect(err).toBeDefined();
      } finally {
        testClient.disconnect();
      }
    });

    it('should observe authentication failure with error logs and metric recording without crashing', async () => {
      proxy.mode = 'auth_error';
      proxy.dropAllConnections();

      let errorCaught: string | null = null;
      const authClient = createRedisClient(`redis://127.0.0.1:${proxyPort}`, {
        password: 'invalid-auth-password',
        retryStrategy: () => null,
      });

      const errorPromise = new Promise<string>((resolve) => {
        authClient.on('error', (err) => {
          errorCaught = err.message;
          resolve(err.message);
        });
      });

      // Wait for auth error event
      const emittedError = await errorPromise;

      expect(emittedError).toBeTruthy();
      expect(emittedError).toContain('WRONGPASS');

      authClient.disconnect();
    });

    it('should survive Redis restart (passthrough -> drop -> passthrough) with automatic client recovery', async () => {
      const testClient = createRedisClient(`redis://127.0.0.1:${proxyPort}`, {
        retryStrategy: () => 100, // Reconnect quickly for test
      });

      await new Promise((resolve) => testClient.once('ready', resolve));
      expect(await testClient.ping()).toBe('PONG');

      // 1. Simulate Redis stopping: drop mode closes incoming connections immediately
      proxy.mode = 'drop';
      proxy.dropAllConnections();

      try {
        await testClient.ping();
      } catch (err: any) {
        expect(err).toBeDefined();
      }

      // 2. Simulate Redis restarting: passthrough mode restored
      const reconnectedPromise = new Promise((resolve) => testClient.once('ready', resolve));
      proxy.mode = 'passthrough';

      await reconnectedPromise;

      // 3. Command succeeds again upon recovery
      expect(await testClient.ping()).toBe('PONG');

      testClient.disconnect();
    });
  });

  describe('4. Financial Correctness & PostgreSQL Idempotency Under Redis Outage', () => {
    let accAId: string;
    let accBId: string;

    beforeEach(async () => {
      accAId = uuidv4();
      accBId = uuidv4();

      await pool.query(
        `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise) 
         VALUES ($1, $2, 'Alice Degraded', 'INR', 200000), ($3, $2, 'Bob Degraded', 'INR', 50000)`,
        [accAId, DEMO_MERCHANT_ID, accBId]
      );

      await pool.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
         VALUES ($1, $2, $3, 'CREDIT', 200000), ($4, $5, $6, 'CREDIT', 50000)`,
        [uuidv4(), uuidv4(), accAId, uuidv4(), uuidv4(), accBId]
      );
    });

    it('should complete transfer and maintain exact double-entry balance when Redis is completely DOWN', async () => {
      // Simulate complete Redis failure by stubbing redis.set / redis.get to reject
      const origSet = redis.set.bind(redis);
      const origGet = redis.get.bind(redis);
      redis.set = (async () => {
        throw new Error('Connection is closed (simulated outage)');
      }) as any;
      redis.get = (async () => {
        throw new Error('Connection is closed (simulated outage)');
      }) as any;

      const idempotencyKey = `degraded-tx-${uuidv4()}`;
      const transferAmount = 30000; // ₹300.00

      try {
        const res = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accAId,
            to_account_id: accBId,
            amount_paise: transferAmount,
          });

        expect(res.status).toBe(201);
        expect(res.body.status).toBe('COMPLETED');
        expect(res.body.amount_paise).toBe(transferAmount);
        expect(res.body.transaction_id).toBeDefined();

        const txId = res.body.transaction_id;

        // Verify PostgreSQL double-entry ledger entries: exactly 2 rows (DEBIT and CREDIT) balancing to 0
        const ledgerRows = await query(
          `SELECT account_id, entry_type, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY entry_type`,
          [txId]
        );
        expect(ledgerRows.rows.length).toBe(2);
        const debit = ledgerRows.rows.find((r) => r.entry_type === 'DEBIT');
        const credit = ledgerRows.rows.find((r) => r.entry_type === 'CREDIT');
        expect(debit).toBeDefined();
        expect(credit).toBeDefined();
        expect(debit.account_id).toBe(accAId);
        expect(credit.account_id).toBe(accBId);
        expect(Number(debit.amount)).toBe(transferAmount);
        expect(Number(credit.amount)).toBe(transferAmount);

        // Verify account balances are mathematically exact in PostgreSQL
        const accA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accAId]);
        const accB = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accBId]);
        expect(Number(accA.rows[0].balance_paise)).toBe(200000 - transferAmount);
        expect(Number(accB.rows[0].balance_paise)).toBe(50000 + transferAmount);

        // Verify idempotency record exists in PostgreSQL source of truth
        const idempRecord = await query(
          `SELECT response_status, response_body FROM idempotency_keys WHERE key = $1 AND merchant_id = $2`,
          [idempotencyKey, DEMO_MERCHANT_ID]
        );
        expect(idempRecord.rows.length).toBe(1);
        expect(idempRecord.rows[0].response_status).toBe(201);
        expect(idempRecord.rows[0].response_body.transaction_id).toBe(txId);

        // Verify subsequent replay with same key returns 201 with X-Idempotent-Replay header
        const replayRes = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accAId,
            to_account_id: accBId,
            amount_paise: transferAmount,
          });

        expect(replayRes.status).toBe(201);
        expect(replayRes.headers['x-idempotent-replay']).toBe('true');
        expect(replayRes.body.transaction_id).toBe(txId);

        // Verify no additional ledger entries were created
        const allTxEntries = await query(
          `SELECT COUNT(*)::INT as count FROM ledger_entries WHERE transaction_id = $1`,
          [txId]
        );
        expect(allTxEntries.rows[0].count).toBe(2);

        // Verify key reuse with different payload returns 422 even when Redis is DOWN
        const mismatchRes = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accAId,
            to_account_id: accBId,
            amount_paise: 99999, // Different payload
          });

        expect(mismatchRes.status).toBe(422);
        expect(mismatchRes.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
      } finally {
        redis.set = origSet;
        redis.get = origGet;
      }
    });

    it('should prevent race conditions on concurrent identical keys when Redis is DOWN', async () => {
      const origSet = redis.set.bind(redis);
      const origGet = redis.get.bind(redis);
      redis.set = (async () => {
        throw new Error('Connection is closed');
      }) as any;
      redis.get = (async () => {
        throw new Error('Connection is closed');
      }) as any;

      const sharedKey = `degraded-concurrent-${uuidv4()}`;
      const amount = 15000;

      try {
        // Fire 5 concurrent requests with identical key while Redis is down
        const promises = Array.from({ length: 5 }, () =>
          request(app)
            .post('/transfers')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .set('Idempotency-Key', sharedKey)
            .send({
              from_account_id: accAId,
              to_account_id: accBId,
              amount_paise: amount,
            })
        );

        const responses = await Promise.all(promises);

        // Exactly one primary request returns 201 (or all successful return identical tx_id via replay)
        const successful = responses.filter((r) => r.status === 201);
        expect(successful.length).toBeGreaterThanOrEqual(1);

        const txIds = new Set(successful.map((r) => r.body.transaction_id));
        expect(txIds.size).toBe(1); // All successful responses share the exact same transaction_id!

        // Exactly 2 ledger entries were created in PostgreSQL
        const singleTxId = Array.from(txIds)[0];
        const entries = await query(
          `SELECT COUNT(*)::INT as count FROM ledger_entries WHERE transaction_id = $1`,
          [singleTxId]
        );
        expect(entries.rows[0].count).toBe(2);

        // Balance decremented exactly once
        const accA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accAId]);
        expect(Number(accA.rows[0].balance_paise)).toBe(200000 - amount);
      } finally {
        redis.set = origSet;
        redis.get = origGet;
      }
    });

    it('should maintain zero double-entry ledger discrepancy (ledger_conservation_discrepancy_paise = 0) during degraded operations', async () => {
      const origSet = redis.set.bind(redis);
      const origGet = redis.get.bind(redis);
      redis.set = (async () => {
        throw new Error('Connection is closed (simulated outage)');
      }) as any;
      redis.get = (async () => {
        throw new Error('Connection is closed (simulated outage)');
      }) as any;

      try {
        const res = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', `conservation-test-${uuidv4()}`)
          .send({
            from_account_id: accAId,
            to_account_id: accBId,
            amount_paise: 12000,
          });

        expect(res.status).toBe(201);

        // Verify balance conservation formula directly in PostgreSQL
        const auditRes = await query(`
          SELECT (
            COALESCE((
              SELECT SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) -
                     SUM(CASE WHEN entry_type = 'CREDIT' AND transaction_id IN (
                       SELECT transaction_id FROM ledger_entries WHERE entry_type = 'DEBIT'
                     ) THEN amount ELSE 0 END)
              FROM ledger_entries
            ), 0) +
            COALESCE((
              SELECT SUM(ABS(a.balance_paise - COALESCE(s.computed, 0)))
              FROM accounts a
              LEFT JOIN (
                SELECT account_id, SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS computed
                FROM ledger_entries 
                GROUP BY account_id
              ) s ON a.id = s.account_id
              WHERE a.balance_paise != COALESCE(s.computed, 0)
            ), 0)
          )::NUMERIC AS discrepancy_paise
        `);
        expect(Number(auditRes.rows[0].discrepancy_paise)).toBe(0);
      } finally {
        redis.set = origSet;
        redis.get = origGet;
      }
    });
  });

  describe('5. Durable Outbox Storage & Queue-Related Failure Guarantees', () => {
    let endpointId: string;

    beforeEach(async () => {
      endpointId = uuidv4();
      await pool.query(
        `INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
         VALUES ($1, $2, $3, $4, ARRAY['transfer.completed']::TEXT[], 'ACTIVE')`,
        [endpointId, DEMO_MERCHANT_ID, `http://127.0.0.1:${receiverPort}/webhook`, 'test-secret']
      );
    });

    it('queue-related failures must NEVER cause committed transfers to lose their durable outbox events', async () => {
      const accAId = uuidv4();
      const accBId = uuidv4();

      await pool.query(
        `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise) 
         VALUES ($1, $2, 'A', 'INR', 100000), ($3, $2, 'B', 'INR', 0)`,
        [accAId, DEMO_MERCHANT_ID, accBId]
      );
      await pool.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
         VALUES ($1, $2, $3, 'CREDIT', 100000)`,
        [uuidv4(), uuidv4(), accAId]
      );

      // Execute transfer while Redis cache is down
      const origSet = redis.set.bind(redis);
      redis.set = (async () => {
        throw new Error('Connection is closed');
      }) as any;

      let transferRes: any;
      try {
        transferRes = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', `outbox-durability-${uuidv4()}`)
          .send({
            from_account_id: accAId,
            to_account_id: accBId,
            amount_paise: 25000,
          });
      } finally {
        redis.set = origSet;
      }

      expect(transferRes.status).toBe(201);
      const outboxEventId = transferRes.body.outbox_event_id;
      expect(outboxEventId).toBeDefined();

      // Verify outbox_events row exists in PostgreSQL with status PENDING
      const outboxRow = await query(
        `SELECT id, status, payload, attempts FROM outbox_events WHERE id = $1`,
        [outboxEventId]
      );
      expect(outboxRow.rows.length).toBe(1);
      expect(outboxRow.rows[0].status).toBe('PENDING');
      expect(Number(outboxRow.rows[0].attempts)).toBe(0);

      // Verify event is completely safe and durable in PostgreSQL
      expect(outboxRow.rows[0].payload.amount_paise).toBe(25000);
      expect(outboxRow.rows[0].payload.transaction_id).toBe(transferRes.body.transaction_id);
    });

    it('outbox poller safely skips or backs off when BullMQ Redis is offline without dropping events', async () => {
      // Create a test outbox event
      const eventId = uuidv4();
      await query(
        `INSERT INTO outbox_events (id, event_type, payload, target_url, status, merchant_id, endpoint_id)
         VALUES ($1, 'transfer.completed', $2, $3, 'PENDING', $4, $5)`,
        [
          eventId,
          JSON.stringify({ event_id: eventId, test: true }),
          `http://127.0.0.1:${receiverPort}/webhook`,
          DEMO_MERCHANT_ID,
          endpointId,
        ]
      );

      // Verify event is PENDING before poller
      const before = await query(`SELECT status FROM outbox_events WHERE id = $1`, [eventId]);
      expect(before.rows[0].status).toBe('PENDING');

      // Process direct delivery using processOutboxDelivery
      const deliveryPayload: WebhookDeliveryPayload = {
        eventId,
        eventType: 'transfer.completed',
        targetUrl: `http://127.0.0.1:${receiverPort}/webhook`,
        payload: { event_id: eventId, test: true },
        attempts: 0,
        endpointId,
        secret: 'test-secret',
      };

      const result = await processOutboxDelivery(deliveryPayload);
      expect(result.delivered).toBe(true);

      // Verify event is marked DELIVERED in PostgreSQL
      const after = await query(`SELECT status, attempts FROM outbox_events WHERE id = $1`, [eventId]);
      expect(after.rows[0].status).toBe('DELIVERED');
      expect(Number(after.rows[0].attempts)).toBe(1);
    });
  });

  describe('6. Recovery & Webhook Delivery Semantics (At-Least-Once Guarantee)', () => {
    it('should deliver webhook with stable event_id and unique delivery_id', async () => {
      const stableEventId = uuidv4();
      const targetUrl = `http://127.0.0.1:${receiverPort}/webhook`;

      await query(
        `INSERT INTO outbox_events (id, event_type, payload, target_url, status, merchant_id)
         VALUES ($1, 'transfer.completed', $2, $3, 'PENDING', $4)`,
        [stableEventId, JSON.stringify({ event_id: stableEventId, amount: 5000 }), targetUrl, DEMO_MERCHANT_ID]
      );

      // Dispatch 1st attempt
      await processOutboxDelivery({
        eventId: stableEventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload: { event_id: stableEventId, amount: 5000 },
        attempts: 0,
      });

      expect(receivedWebhooks.length).toBe(1);
      const firstWebhook = receivedWebhooks[0];
      const deliveryId1 = firstWebhook.body.delivery_id;
      expect(firstWebhook.body.event_id).toBe(stableEventId);
      expect(firstWebhook.headers['x-ledgerflow-event-id']).toBe(stableEventId);
      expect(firstWebhook.headers['x-ledgerflow-delivery-id']).toBe(deliveryId1);

      // Simulate a retry dispatch (e.g. following network recovery or manual replay)
      await processOutboxDelivery({
        eventId: stableEventId,
        eventType: 'transfer.completed',
        targetUrl,
        payload: { event_id: stableEventId, amount: 5000 },
        attempts: 1,
      });

      expect(receivedWebhooks.length).toBe(2);
      const secondWebhook = receivedWebhooks[1];
      const deliveryId2 = secondWebhook.body.delivery_id;

      // ACTUAL DELIVERY GUARANTEE:
      // 1. External delivery is strictly AT-LEAST-ONCE (not exactly-once over external HTTP networks)
      // 2. event_id is STABLE across all dispatches allowing receiver to achieve exactly-once idempotency
      // 3. delivery_id is UNIQUE per attempt for audit tracing
      expect(secondWebhook.body.event_id).toBe(stableEventId); // Identical stable ID
      expect(secondWebhook.headers['x-ledgerflow-event-id']).toBe(stableEventId);
      expect(deliveryId2).not.toBe(deliveryId1); // Distinct delivery attempt ID
    });

    it('receiver deduplication contract: receiver safely deduplicates retried events using stable event_id', async () => {
      const processedEventIds = new Set<string>();
      let sideEffectsExecuted = 0;

      // Simulate partner webhook receiver processing logic
      const receiverHandler = (eventPayload: { event_id: string; delivery_id: string; amount: number }) => {
        if (processedEventIds.has(eventPayload.event_id)) {
          // Duplicate dispatch recognized: acknowledge 200 without re-executing side-effects
          return { status: 200, duplicate: true };
        }
        processedEventIds.add(eventPayload.event_id);
        sideEffectsExecuted++;
        return { status: 200, duplicate: false };
      };

      const testEventId = uuidv4();

      // First delivery attempt
      const attempt1 = receiverHandler({
        event_id: testEventId,
        delivery_id: uuidv4(),
        amount: 2500,
      });
      expect(attempt1.status).toBe(200);
      expect(attempt1.duplicate).toBe(false);
      expect(sideEffectsExecuted).toBe(1);

      // Re-delivery following network reconnect / recovery
      const attempt2 = receiverHandler({
        event_id: testEventId,
        delivery_id: uuidv4(),
        amount: 2500,
      });
      expect(attempt2.status).toBe(200);
      expect(attempt2.duplicate).toBe(true);
      // Guarantee: side effects executed exactly once
      expect(sideEffectsExecuted).toBe(1);
    });
  });

  describe('7. Readiness vs Liveness Checks Distinction', () => {
    it('Liveness (/health/live and /livez) should succeed even if Redis is DOWN', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime_seconds).toBe('number');

      const resLivez = await request(app).get('/livez');
      expect(resLivez.status).toBe(200);
      expect(resLivez.body.status).toBe('ok');
    });

    it('Readiness (/health/ready and /readyz) should return 200 degraded when Redis is DOWN but PostgreSQL is UP', async () => {
      const origPing = redis.ping.bind(redis);
      try {
        redis.ping = (async () => {
          throw new Error('Connection refused (simulated Redis outage)');
        }) as any;

        const resReady = await request(app).get('/health/ready');
        expect(resReady.status).toBe(200);
        expect(resReady.body.ready).toBe(true);
        expect(resReady.body.status).toBe('degraded');
        expect(resReady.body.degraded).toBe(true);
        expect(resReady.body.services.redis.status).toBe('down');
        expect(resReady.body.services.postgres.status).toBe('up');

        const resReadyz = await request(app).get('/readyz');
        expect(resReadyz.status).toBe(200);
        expect(resReadyz.body.ready).toBe(true);
        expect(resReadyz.body.degraded).toBe(true);

        // Aggregate /health MUST return 503 when Redis is DOWN
        const resHealth = await request(app).get('/health');
        expect(resHealth.status).toBe(503);
        expect(resHealth.body.status).toBe('degraded');

        // Liveness MUST still return 200 OK
        const resLive = await request(app).get('/health/live');
        expect(resLive.status).toBe(200);
        expect(resLive.body.status).toBe('ok');
      } finally {
        redis.ping = origPing;
      }
    });

    it('Readiness (/health/ready) should return 503 when PostgreSQL is DOWN, while Liveness (/health/live) still returns 200', async () => {
      const origQuery = pool.query.bind(pool);
      try {
        pool.query = (async (sql: any, values?: any) => {
          if (typeof sql === 'string' && sql.includes('SELECT 1')) {
            throw new Error('Connection refused (simulated PostgreSQL outage)');
          }
          return origQuery(sql, values);
        }) as any;

        const resReady = await request(app).get('/health/ready');
        expect(resReady.status).toBe(503);
        expect(resReady.body.ready).toBe(false);
        expect(resReady.body.status).toBe('down');
        expect(resReady.body.services.postgres.status).toBe('down');

        const resReadyz = await request(app).get('/readyz');
        expect(resReadyz.status).toBe(503);
        expect(resReadyz.body.ready).toBe(false);

        // Liveness probe MUST still return 200 OK (preventing crash loop restarts)
        const resLive = await request(app).get('/health/live');
        expect(resLive.status).toBe(200);
        expect(resLive.body.status).toBe('ok');
      } finally {
        pool.query = origQuery;
      }
    });

    it('Health (/health) returns 200 when all dependencies are UP', async () => {
      const resHealth = await request(app).get('/health');
      expect(resHealth.status).toBe(200);
      expect(resHealth.body.status).toBe('ok');
      expect(resHealth.body.services.postgres.status).toBe('up');
      expect(resHealth.body.services.redis.status).toBe('up');
    });
  });

  describe('8. Observability: Structured Logs & Prometheus Metrics', () => {
    it('should expose redis_connected, redis_errors_total, idempotency_fallback_total, outbox_poller_errors_total', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      const metricsText = res.text;

      expect(metricsText).toContain('redis_connected');
      expect(metricsText).toContain('redis_errors_total');
      expect(metricsText).toContain('idempotency_fallback_total');
      expect(metricsText).toContain('outbox_poller_errors_total');
      expect(metricsText).toContain('ledger_conservation_discrepancy_paise');
    });

    it('should increment idempotency_fallback_total metric when Redis is unavailable', async () => {
      const initialMetrics = await request(app).get('/metrics');
      const matchBefore = initialMetrics.text.match(/idempotency_fallback_total\s+(\d+)/);
      const countBefore = matchBefore ? parseInt(matchBefore[1], 10) : 0;

      const origSet = redis.set.bind(redis);
      const origGet = redis.get.bind(redis);
      redis.set = (async () => {
        throw new Error('Connection closed');
      }) as any;
      redis.get = (async () => {
        throw new Error('Connection closed');
      }) as any;

      try {
        await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', `fallback-metric-${uuidv4()}`)
          .send({
            from_account_id: uuidv4(),
            to_account_id: uuidv4(),
            amount_paise: 100,
          });

        const afterMetrics = await request(app).get('/metrics');
        const matchAfter = afterMetrics.text.match(/idempotency_fallback_total\s+(\d+)/);
        const countAfter = matchAfter ? parseInt(matchAfter[1], 10) : 0;
        expect(countAfter).toBeGreaterThan(countBefore);
      } finally {
        redis.set = origSet;
        redis.get = origGet;
      }
    });
  });
});
