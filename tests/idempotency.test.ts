import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { redis } from '../src/redis/client';
import { query } from '../src/db/pool';
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
});
