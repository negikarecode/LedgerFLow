import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { redis, closeRedis } from '../src/redis/client';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('LedgerFlow Phase 2 - Transfers & Transactional Outbox Suite', () => {
  afterAll(async () => {
    // Ensure clean teardown of connections
    await closePool();
    await closeRedis();
  });

  describe('Validation & Header Checks', () => {
    it('should return 400 Bad Request when Idempotency-Key header is missing', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          from_account_id: uuidv4(),
          to_account_id: uuidv4(),
          amount_paise: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Bad Request');
      expect(res.body.message).toContain('Idempotency-Key header is required');
    });

    it('should return 400 Bad Request when from_account_id equals to_account_id', async () => {
      const sameId = uuidv4();
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: sameId,
          to_account_id: sameId,
          amount_paise: 5000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('to_account_id');
      expect(res.body.details[0].message).toContain('must not be the same');
    });

    it('should return 400 Bad Request when amount_paise is negative or zero', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: uuidv4(),
          to_account_id: uuidv4(),
          amount_paise: -100,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should return 404 Not Found when one or both accounts do not exist', async () => {
      // Create sender account
      const sender = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Sender Exists',
          currency: 'INR',
          initial_credit_paise: 50000,
        });

      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: sender.body.id,
          to_account_id: uuidv4(), // Non-existent
          amount_paise: 1000,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body.message).toContain('One or both accounts not found');
    });
  });

  describe('Normal Transfer & Outbox Creation', () => {
    it('should atomically transfer funds between accounts and record outbox event', async () => {
      // 1. Setup accounts
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Alice Transfer Normal',
          currency: 'INR',
          initial_credit_paise: 100000, // ₹1,000.00
        });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Bob Transfer Normal',
          currency: 'INR',
          initial_credit_paise: 50000, // ₹500.00
        });

      const transferAmount = 30000; // ₹300.00
      const idempotencyKey = uuidv4();
      const webhookUrl = 'https://webhook.site/ledgerflow-test-success';

      // 2. Perform transfer (automatically dispatches to registered webhook endpoints)
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: transferAmount,
        });

      expect(res.status).toBe(201);
      expect(res.body.transaction_id).toBeDefined();
      expect(res.body.from_account_id).toBe(accA.body.id);
      expect(res.body.to_account_id).toBe(accB.body.id);
      expect(res.body.amount_paise).toBe(transferAmount);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.outbox_event_id).toBeDefined();

      // 3. Verify Account A ledger & balance
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerA.status).toBe(200);
      expect(ledgerA.body.balance_paise).toBe(70000); // 100000 - 30000
      expect(ledgerA.body.ledger_entries).toHaveLength(2);
      expect(ledgerA.body.ledger_entries[1].entry_type).toBe('DEBIT');
      expect(ledgerA.body.ledger_entries[1].amount).toBe(transferAmount);

      // 4. Verify Account B ledger & balance
      const ledgerB = await request(app)
        .get(`/accounts/${accB.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerB.status).toBe(200);
      expect(ledgerB.body.balance_paise).toBe(80000); // 50000 + 30000
      expect(ledgerB.body.ledger_entries).toHaveLength(2);
      expect(ledgerB.body.ledger_entries[1].entry_type).toBe('CREDIT');
      expect(ledgerB.body.ledger_entries[1].amount).toBe(transferAmount);

      // 5. Verify Transactional Outbox inspection
      const outboxRes = await request(app)
        .get('/outbox')
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(outboxRes.status).toBe(200);
      expect(outboxRes.body.data.length).toBeGreaterThanOrEqual(1);

      const matchingEvent = outboxRes.body.data.find(
        (e: any) => e.id === res.body.outbox_event_id
      );
      expect(matchingEvent).toBeDefined();
      expect(matchingEvent.event_type).toBe('transfer.completed');
      expect(matchingEvent.status).toBe('PENDING');
      expect(matchingEvent.target_url).toBe('http://127.0.0.1:3000/mock-merchant/webhook');
      expect(matchingEvent.payload.transaction_id).toBe(res.body.transaction_id);
      expect(matchingEvent.payload.amount_paise).toBe(transferAmount);
    });

    it('should return 422 Unprocessable Entity when sender has insufficient funds', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Broke Sender',
          currency: 'INR',
          initial_credit_paise: 5000, // ₹50.00
        });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Recipient',
          currency: 'INR',
          initial_credit_paise: 0,
        });

      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 10000, // ₹100.00 > ₹50.00
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Unprocessable Entity');
      expect(res.body.message).toBe('Insufficient funds');

      // Balances should remain untouched
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerA.body.balance_paise).toBe(5000);
    });
  });

  describe('Idempotency Replay & Conflict Guarantees', () => {
    it('should return cached response with X-Idempotent-Replay: true on exact replay', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Idemp Alice',
          currency: 'INR',
          initial_credit_paise: 100000,
        });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Idemp Bob',
          currency: 'INR',
          initial_credit_paise: 20000,
        });

      const idempotencyKey = `idemp-test-${uuidv4()}`;
      const payload = {
        from_account_id: accA.body.id,
        to_account_id: accB.body.id,
        amount_paise: 25000,
      };

      // First execution
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.headers['x-idempotent-replay']).toBeUndefined();
      expect(res1.body.status).toBe('COMPLETED');

      // Replay execution with identical key and body
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(res1.body.transaction_id);
      expect(res2.body.amount_paise).toBe(25000);

      // Verify that ledger was only debited ONCE
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerA.body.balance_paise).toBe(75000); // 100000 - 25000
      expect(ledgerA.body.ledger_entries).toHaveLength(2); // initial credit + single debit

      const ledgerB = await request(app)
        .get(`/accounts/${accB.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerB.body.balance_paise).toBe(45000); // 20000 + 25000
      expect(ledgerB.body.ledger_entries).toHaveLength(2); // initial credit + single credit
    });

    it('should return 422 Unprocessable Entity when same idempotency key is used with different payload', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Mismatch Alice',
          currency: 'INR',
          initial_credit_paise: 80000,
        });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Mismatch Bob',
          currency: 'INR',
          initial_credit_paise: 10000,
        });

      const idempotencyKey = `idemp-mismatch-${uuidv4()}`;

      // First execution
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 15000,
        });

      expect(res1.status).toBe(201);

      // Second execution with DIFFERENT amount
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 20000, // Different amount!
        });

      expect(res2.status).toBe(422);
      expect(res2.body.error).toBe('Unprocessable Entity');
      expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
      expect(res2.body.message).toContain('different request payload');
    });

    it('should return 409 Conflict when a request with the same key is currently in progress', async () => {
      const inFlightKey = `idemp-inflight-${uuidv4()}`;
      // Manually simulate an in-flight distributed lock in Redis
      await redis.set(`idemp:${DEMO_MERCHANT_ID}:${inFlightKey}`, 'LOCKED', 'EX', 30);

      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', inFlightKey)
        .send({
          from_account_id: uuidv4(),
          to_account_id: uuidv4(),
          amount_paise: 5000,
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Conflict');
      expect(res.body.message).toBe('Request already in progress');

      // Clean up lock
      await redis.del(`idemp:${DEMO_MERCHANT_ID}:${inFlightKey}`);
    });
  });

  describe('Race-Condition Stress Test', () => {
    it(
      'should handle 50 concurrent transfers of 20000 paise on 50000 paise account: exactly 2 succeed (201), 48 fail (422), final balance 10000',
      async () => {
        // 1. Seed Account A with 50,000 paise (₹500.00)
        const accA = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Race Sender',
            currency: 'INR',
            initial_credit_paise: 50000,
          });

        // 2. Seed Account B with 0 paise
        const accB = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Race Recipient',
            currency: 'INR',
            initial_credit_paise: 0,
          });

        expect(accA.status).toBe(201);
        expect(accB.status).toBe(201);

        // 3. Fire 50 concurrent POST /transfers of 20,000 paise each with unique idempotency keys
        const transferPromises = Array.from({ length: 50 }, (_, i) =>
          request(app)
            .post('/transfers')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .set('Idempotency-Key', `stress-key-${i}-${uuidv4()}`)
            .send({
              from_account_id: accA.body.id,
              to_account_id: accB.body.id,
              amount_paise: 20000,
            })
        );

        const responses = await Promise.all(transferPromises);

        // 4. Assert response statuses
        const successResponses = responses.filter((r) => r.status === 201);
        const insufficientFundsResponses = responses.filter((r) => r.status === 422);

        expect(successResponses.length).toBe(2);
        expect(insufficientFundsResponses.length).toBe(48);

        // Ensure every failing request received "Insufficient funds"
        for (const failRes of insufficientFundsResponses) {
          expect(failRes.body.error).toBe('Unprocessable Entity');
          expect(failRes.body.message).toBe('Insufficient funds');
        }

        // 5. Assert final balances
        const ledgerA = await request(app)
          .get(`/accounts/${accA.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(ledgerA.status).toBe(200);
        expect(ledgerA.body.balance_paise).toBe(10000); // 50000 - 20000 - 20000 = 10000 (never negative!)

        const ledgerB = await request(app)
          .get(`/accounts/${accB.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(ledgerB.status).toBe(200);
        expect(ledgerB.body.balance_paise).toBe(40000); // 20000 + 20000 = 40000
      },
      30000
    );
  });

  describe('Opposite-Direction Deadlock Test', () => {
    it(
      'should fire concurrent A -> B and B -> A transfers and assert zero PostgreSQL deadlocks',
      async () => {
        // 1. Seed Account A with 200,000 paise (₹2,000.00)
        const accA = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Deadlock User A',
            currency: 'INR',
            initial_credit_paise: 200000,
          });

        // 2. Seed Account B with 200,000 paise (₹2,000.00)
        const accB = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Deadlock User B',
            currency: 'INR',
            initial_credit_paise: 200000,
          });

        expect(accA.status).toBe(201);
        expect(accB.status).toBe(201);

        // 3. Fire 25 transfers A -> B and 25 transfers B -> A concurrently (50 total)
        const concurrentTransfers = [];
        const transferAmount = 1000; // ₹10.00 each

        for (let i = 0; i < 25; i++) {
          // Transfer from A to B
          concurrentTransfers.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `deadlock-ab-${i}-${uuidv4()}`)
              .send({
                from_account_id: accA.body.id,
                to_account_id: accB.body.id,
                amount_paise: transferAmount,
              })
          );

          // Transfer from B to A simultaneously
          concurrentTransfers.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `deadlock-ba-${i}-${uuidv4()}`)
              .send({
                from_account_id: accB.body.id,
                to_account_id: accA.body.id,
                amount_paise: transferAmount,
              })
          );
        }

        const results = await Promise.all(concurrentTransfers);

        // 4. Assert zero PostgreSQL deadlocks occurred (status 500 or deadlock in body)
        const deadlocks = results.filter(
          (r) =>
            r.status === 500 ||
            JSON.stringify(r.body).toLowerCase().includes('deadlock')
        );
        expect(deadlocks).toHaveLength(0);

        // 5. Assert all transfers succeeded with 201
        const successfulTransfers = results.filter((r) => r.status === 201);
        expect(successfulTransfers.length).toBe(50);

        // 6. Assert balances remain equal (25 * 1000 debited and 25 * 1000 credited on each)
        const finalLedgerA = await request(app)
          .get(`/accounts/${accA.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalLedgerA.body.balance_paise).toBe(200000);

        const finalLedgerB = await request(app)
          .get(`/accounts/${accB.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalLedgerB.body.balance_paise).toBe(200000);
      },
      30000
    );
  });
});
