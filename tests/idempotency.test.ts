import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { redis } from '../src/redis/client';
import { query } from '../src/db/pool';
import { env } from '../src/config/env';
import {
  canonicalizeJson,
  computeRequestFingerprint,
  releaseSafeLock,
  cleanupExpiredIdempotencyKeys,
} from '../src/api/middlewares/idempotency';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('LedgerFlow Idempotency Hardening & Resilience Suite', () => {
  beforeEach(async () => {
    // Ensure clean Redis demo keys
    const keys = await redis.keys(`idemp:${DEMO_MERCHANT_ID}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe('Deterministic Fingerprinting & Canonicalization', () => {
    it('produces identical fingerprints regardless of JSON object key insertion order', () => {
      const body1 = { b: 200, a: 100, nested: { y: 'bar', x: 'foo' } };
      const body2 = { a: 100, nested: { x: 'foo', y: 'bar' }, b: 200 };

      const fp1 = computeRequestFingerprint('POST', '/transfers', body1);
      const fp2 = computeRequestFingerprint('post', '/transfers/', body2);

      expect(fp1).toBe(fp2);
    });

    it('produces different fingerprints for different request payloads', () => {
      const body1 = { amount_paise: 1000 };
      const body2 = { amount_paise: 2000 };

      const fp1 = computeRequestFingerprint('POST', '/transfers', body1);
      const fp2 = computeRequestFingerprint('POST', '/transfers', body2);

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('Safe Lock Release (Lua Compare-and-Delete)', () => {
    it('only allows the lock owner holding the unique token to delete the lock', async () => {
      const lockKey = `idemp:${DEMO_MERCHANT_ID}:test-lock-${uuidv4()}`;
      const ownerToken = uuidv4();
      const attackerToken = uuidv4();

      // Store in-flight lock payload
      const payload = JSON.stringify({
        status: 'IN_FLIGHT',
        token: ownerToken,
        request_hash: 'abc123hash',
      });
      await redis.set(lockKey, payload, 'EX', 30);

      // Attacker tries to release the lock with wrong token -> must fail (return false)
      const attackerReleased = await releaseSafeLock(lockKey, attackerToken);
      expect(attackerReleased).toBe(false);

      // Verify lock still exists in Redis
      const currentVal = await redis.get(lockKey);
      expect(currentVal).toBe(payload);

      // Owner releases the lock -> must succeed (return true)
      const ownerReleased = await releaseSafeLock(lockKey, ownerToken);
      expect(ownerReleased).toBe(true);

      // Verify lock was deleted
      const afterVal = await redis.get(lockKey);
      expect(afterVal).toBeNull();
    });
  });

  describe('Key Reuse With Different Body (422 Error)', () => {
    it('returns 422 with IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD when payload changes', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Fingerprint Alice', currency: 'INR', initial_credit_paise: 100000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Fingerprint Bob', currency: 'INR', initial_credit_paise: 20000 });

      const idempotencyKey = `fp-test-${uuidv4()}`;

      // 1. First execution: 15,000 paise
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
      expect(res1.body.amount_paise).toBe(15000);

      // 2. Second execution: same key, but different amount (25,000 paise)
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 25000,
        });

      expect(res2.status).toBe(422);
      expect(res2.body.error).toBe('Unprocessable Entity');
      expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
      expect(res2.body.message).toContain('different request payload');

      // 3. Verify ledger entries: funds moved strictly ONCE (15,000 paise)
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerA.body.balance_paise).toBe(85000); // 100,000 - 15,000
    });

    it('returns 201 replay when JSON fields are in different order (canonicalization)', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Canon Alice', currency: 'INR', initial_credit_paise: 50000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Canon Bob', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `canon-test-${uuidv4()}`;

      // Original order: from, to, amount
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 10000,
        });

      expect(res1.status).toBe(201);
      const originalTxId = res1.body.transaction_id;

      // Reordered keys: amount, to, from
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          amount_paise: 10000,
          to_account_id: accB.body.id,
          from_account_id: accA.body.id,
        });

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(originalTxId);
    });
  });

  describe('Simulated Redis Flush Mid-Flight', () => {
    it('safely falls back to PostgreSQL durable store when Redis is flushed between requests', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Flush Alice', currency: 'INR', initial_credit_paise: 70000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Flush Bob', currency: 'INR', initial_credit_paise: 30000 });

      const idempotencyKey = `flush-test-${uuidv4()}`;

      // 1. Initial successful transfer
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 20000,
        });

      expect(res1.status).toBe(201);
      const originalTxId = res1.body.transaction_id;

      // 2. SIMULATE REDIS OUTAGE / CACHE WIPE
      await redis.flushall();

      // Verify Redis is completely empty
      const cached = await redis.get(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      expect(cached).toBeNull();

      // 3. Second request arrives with the same key
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 20000,
        });

      // Must recover from PostgreSQL durable record with X-Idempotent-Replay: true
      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(originalTxId);

      // Verify total balance in DB: 20,000 moved exactly once
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledgerA.body.balance_paise).toBe(50000); // 70,000 - 20,000
    });
  });

  describe('Simulated Lock Expiry With Concurrent Executors (Zero Double-Apply)', () => {
    it('guarantees funds are moved exactly once even if the Redis lock expires while Postgres is processing', async () => {
      // 1. Seed Account A with ₹500 (50,000 paise). Total transfer is ₹500.
      // If double-apply occurs, Account A would be overdrafted (-50,000) or Account B would get ₹1,000.
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Expiry Alice', currency: 'INR', initial_credit_paise: 50000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Expiry Bob', currency: 'INR', initial_credit_paise: 0 });

      const idempotencyKey = `lock-expiry-${uuidv4()}`;
      const redisKey = `idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`;

      // Simulate: Executor 1 acquires Redis lock and starts.
      // Then, before Executor 2 arrives, the Redis lock expires (TTL simulated via deleting or setting short TTL).
      // Fire 5 concurrent requests with the identical idempotency key where Redis lock is cleared right at the start.
      await redis.del(redisKey);

      const makeRequest = () =>
        request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accA.body.id,
            to_account_id: accB.body.id,
            amount_paise: 50000,
          });

      // Fire 5 requests in parallel with deliberate Redis lock deletions between them
      const results = await Promise.all([
        makeRequest(),
        (async () => {
          await redis.del(redisKey); // Simulate lock expiring
          return makeRequest();
        })(),
        (async () => {
          await redis.del(redisKey); // Simulate lock expiring
          return makeRequest();
        })(),
      ]);

      // All requests must either be 201 Created or 409 Conflict (never 500 error, never double debit)
      for (const res of results) {
        expect([201, 409]).toContain(res.status);
      }

      // Check transaction IDs: every successful response must return the EXACT same transaction ID
      const successfulTxs = results
        .filter((r) => r.status === 201)
        .map((r) => r.body.transaction_id);
      expect(successfulTxs.length).toBeGreaterThanOrEqual(1);
      const uniqueTxIds = new Set(successfulTxs);
      expect(uniqueTxIds.size).toBe(1);

      // STRICT CONSERVATION ASSERTION:
      // Final Account A balance MUST BE exactly 0 paise (NOT negative, NOT double debited)
      // Final Account B balance MUST BE exactly 50000 paise (NOT 100,000 paise)
      const ledgerA = await request(app)
        .get(`/accounts/${accA.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      const ledgerB = await request(app)
        .get(`/accounts/${accB.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(ledgerA.body.balance_paise).toBe(0);
      expect(ledgerB.body.balance_paise).toBe(50000);
      expect(ledgerA.body.balance_paise + ledgerB.body.balance_paise).toBe(50000);
    });
  });

  describe('Redis Unavailable Fault Tolerance', () => {
    it('executes transfers correctly using PostgreSQL as single source of truth when Redis is down', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'NoRedis Alice', currency: 'INR', initial_credit_paise: 60000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'NoRedis Bob', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `noredis-test-${uuidv4()}`;

      // Stub redis.set and redis.get to simulate complete Redis outage
      const originalSet = redis.set.bind(redis);
      const originalGet = redis.get.bind(redis);

      redis.set = (async () => {
        throw new Error('ECONNREFUSED: Redis connection unavailable');
      }) as any;
      redis.get = (async () => {
        throw new Error('ECONNREFUSED: Redis connection unavailable');
      }) as any;

      try {
        // 1. First execution without Redis
        const res1 = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accA.body.id,
            to_account_id: accB.body.id,
            amount_paise: 25000,
          });

        expect(res1.status).toBe(201);
        expect(res1.body.amount_paise).toBe(25000);
        const txId = res1.body.transaction_id;

        // 2. Replay with identical key without Redis
        const res2 = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accA.body.id,
            to_account_id: accB.body.id,
            amount_paise: 25000,
          });

        expect(res2.status).toBe(201);
        expect(res2.headers['x-idempotent-replay']).toBe('true');
        expect(res2.body.transaction_id).toBe(txId);

        // 3. Different payload with same key without Redis -> must return 422
        const res3 = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accA.body.id,
            to_account_id: accB.body.id,
            amount_paise: 99999,
          });

        expect(res3.status).toBe(422);
        expect(res3.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');

        // 4. Assert ledger balance
        const ledgerA = await request(app)
          .get(`/accounts/${accA.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(ledgerA.body.balance_paise).toBe(35000); // 60,000 - 25,000
      } finally {
        // Restore Redis methods
        redis.set = originalSet;
        redis.get = originalGet;
      }
    });
  });

  describe('TTL Retention & Cleanup Policy', () => {
    it('prunes records older than configured retention window and preserves recent records', async () => {
      const oldKey = `old-expired-${uuidv4()}`;
      const freshKey = `fresh-active-${uuidv4()}`;

      // Insert an expired record (created 48 hours ago)
      await query(
        `INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body, created_at)
         VALUES ($1, $2, 'hash1', 201, '{"status":"ok"}', NOW() - INTERVAL '48 hours')`,
        [oldKey, DEMO_MERCHANT_ID]
      );

      // Insert a fresh record (created now)
      await query(
        `INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body, created_at)
         VALUES ($1, $2, 'hash2', 201, '{"status":"ok"}', NOW())`,
        [freshKey, DEMO_MERCHANT_ID]
      );

      // Run cleanup with 24-hour retention (86,400 seconds)
      const prunedCount = await cleanupExpiredIdempotencyKeys(86400);
      expect(prunedCount).toBeGreaterThanOrEqual(1);

      // Verify old key was pruned
      const checkOld = await query(
        `SELECT key FROM idempotency_keys WHERE key = $1 AND merchant_id = $2`,
        [oldKey, DEMO_MERCHANT_ID]
      );
      expect(checkOld.rows.length).toBe(0);

      // Verify fresh key still exists
      const checkFresh = await query(
        `SELECT key FROM idempotency_keys WHERE key = $1 AND merchant_id = $2`,
        [freshKey, DEMO_MERCHANT_ID]
      );
      expect(checkFresh.rows.length).toBe(1);

      // Clean up test key
      await query(`DELETE FROM idempotency_keys WHERE key = $1`, [freshKey]);
    });
  });

  describe('Requirement 1: Exact Canonical Replay & Zero Side-Effect DB Invariants', () => {
    it('returns original committed response on identical replay with zero additional ledger entries, balance changes, or outbox events', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req1 Alice', currency: 'INR', initial_credit_paise: 80000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req1 Bob', currency: 'INR', initial_credit_paise: 20000 });

      const idempotencyKey = `req1-exact-${uuidv4()}`;
      const payload = {
        from_account_id: accA.body.id,
        to_account_id: accB.body.id,
        amount_paise: 30000,
      };

      // 1. Initial execution
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      const txId = res1.body.transaction_id;
      expect(res1.headers['x-idempotent-replay']).toBeUndefined();

      // Query database state immediately after first execution
      const initialLedger = await query(
        `SELECT id, account_id, entry_type, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY entry_type`,
        [txId]
      );
      expect(initialLedger.rows.length).toBe(2);

      const initialOutbox = await query(
        `SELECT id, payload FROM outbox_events WHERE payload->>'transaction_id' = $1`,
        [txId]
      );
      const initialOutboxCount = initialOutbox.rows.length;

      const initialAccA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accA.body.id]);
      const initialAccB = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accB.body.id]);
      expect(Number(initialAccA.rows[0].balance_paise)).toBe(50000);
      expect(Number(initialAccB.rows[0].balance_paise)).toBe(50000);

      // Total count of all ledger entries for this account
      const totalEntriesBefore = await query(
        `SELECT COUNT(*) FROM ledger_entries WHERE account_id IN ($1, $2)`,
        [accA.body.id, accB.body.id]
      );

      // 2. Replay request with IDENTICAL canonical request
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(txId);
      expect(res2.body.amount_paise).toBe(30000);

      // 3. Database assertions: verify zero additional records created
      const totalEntriesAfter = await query(
        `SELECT COUNT(*) FROM ledger_entries WHERE account_id IN ($1, $2)`,
        [accA.body.id, accB.body.id]
      );
      expect(Number(totalEntriesAfter.rows[0].count)).toBe(Number(totalEntriesBefore.rows[0].count));

      const afterOutbox = await query(
        `SELECT id FROM outbox_events WHERE payload->>'transaction_id' = $1`,
        [txId]
      );
      expect(afterOutbox.rows.length).toBe(initialOutboxCount);

      const afterAccA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accA.body.id]);
      const afterAccB = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accB.body.id]);
      expect(Number(afterAccA.rows[0].balance_paise)).toBe(50000);
      expect(Number(afterAccB.rows[0].balance_paise)).toBe(50000);
    });
  });

  describe('Requirement 2: Deterministic Conflict Response on Key Reuse With Different Payload', () => {
    it('returns deterministic 422 with IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD when amount differs across Redis and Postgres', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req2 Alice', currency: 'INR', initial_credit_paise: 90000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req2 Bob', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `req2-mismatch-${uuidv4()}`;

      // 1. Initial execution: amount 10000
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 10000,
        });
      expect(res1.status).toBe(201);

      // 2. Mismatch against Redis cache: amount 20000
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 20000,
        });
      expect(res2.status).toBe(422);
      expect(res2.body.error).toBe('Unprocessable Entity');
      expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');

      // 3. Flush Redis and attempt mismatch against PostgreSQL durable record directly
      await redis.del(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      const res3 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 30000,
        });
      expect(res3.status).toBe(422);
      expect(res3.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
    });

    it('returns 422 when recipient account differs for the same idempotency key', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req2 Dest A', currency: 'INR', initial_credit_paise: 50000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req2 Dest B', currency: 'INR', initial_credit_paise: 10000 });
      const accC = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req2 Dest C', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `req2-diff-dest-${uuidv4()}`;

      // 1. Initial transfer to accB
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 5000,
        });
      expect(res1.status).toBe(201);

      // 2. Same key but to accC
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accC.body.id,
          amount_paise: 5000,
        });
      expect(res2.status).toBe(422);
      expect(res2.body.code).toBe('IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD');
    });
  });

  describe('Requirement 3: Concurrent Requests Idempotency Guard & Zero Double-Apply', () => {
    it('ensures multiple concurrent requests with the same key execute the transfer strictly once', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req3 Alice', currency: 'INR', initial_credit_paise: 100000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req3 Bob', currency: 'INR', initial_credit_paise: 0 });

      const idempotencyKey = `req3-concurrent-${uuidv4()}`;

      // Fire 10 concurrent requests with identical key and payload
      const promises = Array.from({ length: 10 }, () =>
        request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({
            from_account_id: accA.body.id,
            to_account_id: accB.body.id,
            amount_paise: 25000,
          })
      );

      const responses = await Promise.all(promises);

      // Every response must be either 201 (Created or Replay) or 409 (Conflict in flight)
      for (const res of responses) {
        expect([201, 409]).toContain(res.status);
      }

      // Collect all 201 transaction IDs: must all be identical
      const successResponses = responses.filter((r) => r.status === 201);
      expect(successResponses.length).toBeGreaterThanOrEqual(1);
      const uniqueTxIds = new Set(successResponses.map((r) => r.body.transaction_id));
      expect(uniqueTxIds.size).toBe(1);

      // Verify DB balances: 25,000 paise moved strictly ONCE
      const balA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accA.body.id]);
      const balB = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accB.body.id]);
      expect(Number(balA.rows[0].balance_paise)).toBe(75000);
      expect(Number(balB.rows[0].balance_paise)).toBe(25000);

      // Ledger entries for this transaction: strictly 2
      const txId = successResponses[0].body.transaction_id;
      const ledger = await query(`SELECT id FROM ledger_entries WHERE transaction_id = $1`, [txId]);
      expect(ledger.rows.length).toBe(2);
    });
  });

  describe('Requirement 4: Failed, Rejected, and Rolled-back Transfers Do Not Leave Stale Records', () => {
    it('does not leave a successful idempotency record or stale Redis lock on insufficient funds (422)', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req4 Poor Alice', currency: 'INR', initial_credit_paise: 1000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Req4 Bob', currency: 'INR', initial_credit_paise: 0 });

      const idempotencyKey = `req4-fail-funds-${uuidv4()}`;

      // 1. Attempt transfer exceeding balance
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 50000,
        });

      expect(res1.status).toBe(422);
      expect(res1.body.message).toBe('Insufficient funds');

      // 2. Assert Redis lock was released
      const lockInRedis = await redis.get(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      expect(lockInRedis).toBeNull();

      // 3. Assert PostgreSQL has no successful idempotency record
      const idempInDb = await query(
        `SELECT * FROM idempotency_keys WHERE key = $1 AND merchant_id = $2`,
        [idempotencyKey, DEMO_MERCHANT_ID]
      );
      expect(idempInDb.rows.length).toBe(0);

      // 4. Same key can be used immediately for a valid transfer with affordable amount
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: accA.body.id,
          to_account_id: accB.body.id,
          amount_paise: 500,
        });

      expect(res2.status).toBe(201);
      expect(res2.body.amount_paise).toBe(500);
    });

    it('does not leave a stale Redis lock or DB record on missing accounts (404)', async () => {
      const idempotencyKey = `req4-fail-404-${uuidv4()}`;

      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: uuidv4(),
          to_account_id: uuidv4(),
          amount_paise: 1000,
        });

      expect(res1.status).toBe(404);

      // Assert lock released
      const lockInRedis = await redis.get(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      expect(lockInRedis).toBeNull();

      const idempInDb = await query(
        `SELECT * FROM idempotency_keys WHERE key = $1 AND merchant_id = $2`,
        [idempotencyKey, DEMO_MERCHANT_ID]
      );
      expect(idempInDb.rows.length).toBe(0);
    });

    it('does not leave a stale Redis lock on validation error (400)', async () => {
      const idempotencyKey = `req4-fail-400-${uuidv4()}`;

      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({
          from_account_id: uuidv4(),
          to_account_id: uuidv4(),
          amount_paise: -500,
        });

      expect(res1.status).toBe(400);

      const lockInRedis = await redis.get(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      expect(lockInRedis).toBeNull();
    });
  });

  describe('Requirement 5 & 7: Stale-Lock Healing & Crash Recovery (Post-Commit Disconnect)', () => {
    it('recovers and returns 201 replay when Redis still holds IN_FLIGHT after PostgreSQL commit (healing Redis)', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Crash Alice', currency: 'INR', initial_credit_paise: 60000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Crash Bob', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `crash-heal-${uuidv4()}`;
      const payload = {
        from_account_id: accA.body.id,
        to_account_id: accB.body.id,
        amount_paise: 20000,
      };

      // 1. Execute transfer successfully
      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);
      const originalTxId = res1.body.transaction_id;

      // 2. SIMULATE POST-COMMIT CRASH BEFORE REDIS CACHE UPDATE:
      // Overwrite Redis with an IN_FLIGHT lock, simulating that the process crashed right after COMMIT
      // before updating Redis cache.
      const fp = computeRequestFingerprint('POST', '/transfers', payload);
      await redis.set(
        `idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`,
        JSON.stringify({
          status: 'IN_FLIGHT',
          token: uuidv4(),
          request_hash: fp,
        }),
        'EX',
        30
      );

      // 3. Client retries with the same idempotency key
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      // Must return 201 Replay from PostgreSQL durable store (NOT 409 Conflict!)
      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(originalTxId);

      // 4. Verify Redis was healed from IN_FLIGHT to the completed response
      const healedVal = await redis.get(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`);
      expect(healedVal).not.toBeNull();
      const parsedHealed = JSON.parse(healedVal!);
      expect(parsedHealed.response_status).toBe(201);
      expect(parsedHealed.response_body.transaction_id).toBe(originalTxId);
    });

    it('recovers and returns 201 replay when Redis has legacy LOCKED format after commit', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Locked Alice', currency: 'INR', initial_credit_paise: 40000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'Locked Bob', currency: 'INR', initial_credit_paise: 10000 });

      const idempotencyKey = `legacy-locked-${uuidv4()}`;
      const payload = {
        from_account_id: accA.body.id,
        to_account_id: accB.body.id,
        amount_paise: 10000,
      };

      const res1 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(201);

      // Overwrite with legacy string format
      await redis.set(`idemp:${DEMO_MERCHANT_ID}:${idempotencyKey}`, 'LOCKED', 'EX', 30);

      // Retry must heal and return 201 replay
      const res2 = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.body.transaction_id).toBe(res1.body.transaction_id);
    });
  });

  describe('Requirement 5c: Concurrent Requests When Redis Is Unavailable', () => {
    it('serializes concurrent requests via PostgreSQL durable locking when Redis is down', async () => {
      const accA = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'NoRedis Conc A', currency: 'INR', initial_credit_paise: 50000 });
      const accB = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({ owner_name: 'NoRedis Conc B', currency: 'INR', initial_credit_paise: 0 });

      const idempotencyKey = `noredis-concurrent-${uuidv4()}`;

      // Stub Redis to be completely down
      const origSet = redis.set.bind(redis);
      const origGet = redis.get.bind(redis);
      redis.set = (async () => {
        throw new Error('ECONNREFUSED');
      }) as any;
      redis.get = (async () => {
        throw new Error('ECONNREFUSED');
      }) as any;

      try {
        const promises = Array.from({ length: 5 }, () =>
          request(app)
            .post('/transfers')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .set('Idempotency-Key', idempotencyKey)
            .send({
              from_account_id: accA.body.id,
              to_account_id: accB.body.id,
              amount_paise: 20000,
            })
        );

        const results = await Promise.all(promises);

        // Every request must succeed with 201 (either initial or replay)
        for (const res of results) {
          expect(res.status).toBe(201);
        }

        // All must have the exact same transaction ID
        const txIds = results.map((r) => r.body.transaction_id);
        expect(new Set(txIds).size).toBe(1);

        // Balance must be debited strictly once (50000 - 20000 = 30000)
        const balA = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accA.body.id]);
        const balB = await query(`SELECT balance_paise FROM accounts WHERE id = $1`, [accB.body.id]);
        expect(Number(balA.rows[0].balance_paise)).toBe(30000);
        expect(Number(balB.rows[0].balance_paise)).toBe(20000);
      } finally {
        redis.set = origSet;
        redis.get = origGet;
      }
    });
  });

  describe('Requirement 6: Lock Ownership & Release Semantics', () => {
    it('ensures releaseSafeLock cannot delete a completed cached response', async () => {
      const cachedKey = `idemp:${DEMO_MERCHANT_ID}:completed-${uuidv4()}`;
      const cachedPayload = JSON.stringify({
        request_hash: 'hash-abc',
        response_status: 201,
        response_body: { transaction_id: 'tx-123' },
      });
      await redis.set(cachedKey, cachedPayload, 'EX', 60);

      // Any attempt to delete with any token must fail
      const deleted = await releaseSafeLock(cachedKey, uuidv4());
      expect(deleted).toBe(false);

      // Key must still exist in Redis
      const val = await redis.get(cachedKey);
      expect(val).toBe(cachedPayload);

      await redis.del(cachedKey);
    });

    it('ensures an old expired lock holder cannot release a new lock taken by another request', async () => {
      const lockKey = `idemp:${DEMO_MERCHANT_ID}:lease-takeover-${uuidv4()}`;
      const oldOwnerToken = uuidv4();
      const newOwnerToken = uuidv4();

      // Request 1 acquires lock
      await redis.set(
        lockKey,
        JSON.stringify({ status: 'IN_FLIGHT', token: oldOwnerToken, request_hash: 'h1' }),
        'EX',
        30
      );

      // Simulate Request 2 taking over lock after TTL
      await redis.set(
        lockKey,
        JSON.stringify({ status: 'IN_FLIGHT', token: newOwnerToken, request_hash: 'h1' }),
        'EX',
        30
      );

      // Request 1 attempts to release the lock using old token
      const oldReleased = await releaseSafeLock(lockKey, oldOwnerToken);
      expect(oldReleased).toBe(false);

      // New owner lock must still be intact
      const current = await redis.get(lockKey);
      expect(JSON.parse(current!).token).toBe(newOwnerToken);

      await redis.del(lockKey);
    });
  });

  describe('Requirement 8: Multi-Tenant Isolation for Identical Idempotency Keys', () => {
    it('allows two different merchants to use the identical idempotency key simultaneously without collision', async () => {
      const adminToken = env.ADMIN_TOKEN;

      // 1. Create Merchant Alpha
      const resAlpha = await request(app)
        .post('/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Tenant Alpha ${Date.now()}` });
      expect(resAlpha.status).toBe(201);
      const alphaMerchant = resAlpha.body.merchant;
      const alphaKey = resAlpha.body.api_key.key;

      // 2. Create Merchant Beta
      const resBeta = await request(app)
        .post('/admin/merchants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Tenant Beta ${Date.now()}` });
      expect(resBeta.status).toBe(201);
      const betaMerchant = resBeta.body.merchant;
      const betaKey = resBeta.body.api_key.key;

      // 3. Create accounts for Alpha
      const alphaAcc1 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${alphaKey}`)
        .send({ owner_name: 'Alpha One', currency: 'INR', initial_credit_paise: 50000 });
      const alphaAcc2 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${alphaKey}`)
        .send({ owner_name: 'Alpha Two', currency: 'INR', initial_credit_paise: 10000 });

      // 4. Create accounts for Beta
      const betaAcc1 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${betaKey}`)
        .send({ owner_name: 'Beta One', currency: 'INR', initial_credit_paise: 90000 });
      const betaAcc2 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${betaKey}`)
        .send({ owner_name: 'Beta Two', currency: 'INR', initial_credit_paise: 20000 });

      // 5. Use the EXACT same idempotency key for both tenants
      const sharedKey = `shared-tenant-key-${uuidv4()}`;

      // Execute transfer for Alpha
      const resAlphaTransfer = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${alphaKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: alphaAcc1.body.id,
          to_account_id: alphaAcc2.body.id,
          amount_paise: 15000,
        });
      expect(resAlphaTransfer.status).toBe(201);
      const alphaTxId = resAlphaTransfer.body.transaction_id;

      // Execute transfer for Beta with the IDENTICAL Idempotency-Key
      const resBetaTransfer = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${betaKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: betaAcc1.body.id,
          to_account_id: betaAcc2.body.id,
          amount_paise: 35000,
        });
      expect(resBetaTransfer.status).toBe(201);
      const betaTxId = resBetaTransfer.body.transaction_id;

      // Verify they are completely different transfers
      expect(alphaTxId).not.toBe(betaTxId);
      expect(resAlphaTransfer.body.amount_paise).toBe(15000);
      expect(resBetaTransfer.body.amount_paise).toBe(35000);

      // 6. Replays are isolated per tenant
      const replayAlpha = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${alphaKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: alphaAcc1.body.id,
          to_account_id: alphaAcc2.body.id,
          amount_paise: 15000,
        });
      expect(replayAlpha.status).toBe(201);
      expect(replayAlpha.headers['x-idempotent-replay']).toBe('true');
      expect(replayAlpha.body.transaction_id).toBe(alphaTxId);

      const replayBeta = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${betaKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: betaAcc1.body.id,
          to_account_id: betaAcc2.body.id,
          amount_paise: 35000,
        });
      expect(replayBeta.status).toBe(201);
      expect(replayBeta.headers['x-idempotent-replay']).toBe('true');
      expect(replayBeta.body.transaction_id).toBe(betaTxId);

      // 7. Verify database stores two separate idempotency rows with composite key (merchant_id, key)
      const idempRows = await query(
        `SELECT merchant_id, key, response_body->>'transaction_id' as tx_id 
         FROM idempotency_keys 
         WHERE key = $1 ORDER BY merchant_id`,
        [sharedKey]
      );
      expect(idempRows.rows.length).toBe(2);
      expect(idempRows.rows.map((r) => r.merchant_id).sort()).toEqual(
        [alphaMerchant.id, betaMerchant.id].sort()
      );
    });
  });
});
