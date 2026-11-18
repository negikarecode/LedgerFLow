import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { reconcileAccountBalances } from '../src/services/reconciliation';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

interface ConcurrencyMetrics {
  total: number;
  status201: number;
  status422Insufficient: number;
  status409Conflict: number;
  status500Deadlocks: number;
  status500Serialization: number;
  otherStatuses: number;
  latenciesMs: number[];
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

function computeMetrics(
  responses: Array<{ status: number; body: any; durationMs: number }>
): ConcurrencyMetrics {
  const latencies = responses.map((r) => r.durationMs).sort((a, b) => a - b);
  const total = responses.length;

  let status201 = 0;
  let status422Insufficient = 0;
  let status409Conflict = 0;
  let status500Deadlocks = 0;
  let status500Serialization = 0;
  let otherStatuses = 0;

  for (const r of responses) {
    if (r.status === 201) {
      status201++;
    } else if (r.status === 422 && r.body?.message === 'Insufficient funds') {
      status422Insufficient++;
    } else if (r.status === 409) {
      status409Conflict++;
    } else if (
      r.status === 500 &&
      JSON.stringify(r.body).toLowerCase().includes('deadlock')
    ) {
      status500Deadlocks++;
    } else if (
      r.status === 500 &&
      JSON.stringify(r.body).toLowerCase().includes('serialization')
    ) {
      status500Serialization++;
    } else {
      otherStatuses++;
    }
  }

  const p50Index = Math.floor(latencies.length * 0.5);
  const p90Index = Math.floor(latencies.length * 0.9);
  const p95Index = Math.floor(latencies.length * 0.95);
  const p99Index = Math.floor(latencies.length * 0.99);

  const sum = latencies.reduce((a, b) => a + b, 0);

  return {
    total,
    status201,
    status422Insufficient,
    status409Conflict,
    status500Deadlocks,
    status500Serialization,
    otherStatuses,
    latenciesMs: latencies,
    p50Ms: latencies[p50Index] ?? 0,
    p90Ms: latencies[p90Index] ?? 0,
    p95Ms: latencies[p95Index] ?? 0,
    p99Ms: latencies[p99Index] ?? 0,
    avgMs: total > 0 ? Number((sum / total).toFixed(2)) : 0,
    minMs: latencies[0] ?? 0,
    maxMs: latencies[latencies.length - 1] ?? 0,
  };
}

describe('Concurrency Correctness & Stress Audit Suite', () => {
  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('1. Simultaneous Overdraft Protection (Row Locking & Zero Overdraft)', () => {
    it(
      'should handle 30 simultaneous withdrawal requests exceeding balance: exactly 2 succeed, 28 fail, final balance exact',
      async () => {
        // Source wallet with 100,000 paise (₹1,000.00)
        const sourceAcc = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Overdraft Source',
            currency: 'INR',
            initial_credit_paise: 100000,
          });

        const destAcc = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Overdraft Dest',
            currency: 'INR',
            initial_credit_paise: 0,
          });

        expect(sourceAcc.status).toBe(201);
        expect(destAcc.status).toBe(201);

        const withdrawalAmount = 40000; // ₹400.00 each
        const totalRequests = 30; // 30 * 40,000 = 1,200,000 paise requested (far exceeds 100,000)

        const tasks = [];
        for (let i = 0; i < totalRequests; i++) {
          const startTime = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `sim-overdraft-${i}-${uuidv4()}`)
              .send({
                from_account_id: sourceAcc.body.id,
                to_account_id: destAcc.body.id,
                amount_paise: withdrawalAmount,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - startTime,
              }))
          );
        }

        const responses = await Promise.all(tasks);
        const metrics = computeMetrics(responses);

        // Concurrency assertions
        expect(metrics.status500Deadlocks).toBe(0);
        expect(metrics.status500Serialization).toBe(0);
        expect(metrics.status201).toBe(2); // Exactly 2 * 40,000 = 80,000 paise withdrawn
        expect(metrics.status422Insufficient).toBe(28); // Exactly 28 rejected

        // Final balance assertions: exactly 20,000 paise remaining (never negative!)
        const finalSource = await request(app)
          .get(`/accounts/${sourceAcc.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalSource.body.balance_paise).toBe(20000);

        const finalDest = await request(app)
          .get(`/accounts/${destAcc.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalDest.body.balance_paise).toBe(80000);

        // Verify ledger entries conservation
        expect(finalSource.body.ledger_entries.filter((e: any) => e.entry_type === 'DEBIT')).toHaveLength(2);
        expect(finalDest.body.ledger_entries.filter((e: any) => e.entry_type === 'CREDIT')).toHaveLength(2);
      },
      30000
    );
  });

  describe('2. Deterministic Lock Ordering & Opposite-Direction Deadlock Prevention', () => {
    it(
      'should execute concurrent A -> B and B -> A transfers simultaneously with zero deadlocks',
      async () => {
        const accA = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Deadlock Test Acc A',
            currency: 'INR',
            initial_credit_paise: 200000, // ₹2,000.00
          });

        const accB = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Deadlock Test Acc B',
            currency: 'INR',
            initial_credit_paise: 200000, // ₹2,000.00
          });

        expect(accA.status).toBe(201);
        expect(accB.status).toBe(201);

        const transferAmount = 1000; // ₹10.00 each
        const tasks = [];

        // 25 transfers from A -> B and 25 transfers from B -> A concurrently (50 total)
        for (let i = 0; i < 25; i++) {
          const startAB = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `opp-ab-${i}-${uuidv4()}`)
              .send({
                from_account_id: accA.body.id,
                to_account_id: accB.body.id,
                amount_paise: transferAmount,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - startAB,
              }))
          );

          const startBA = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `opp-ba-${i}-${uuidv4()}`)
              .send({
                from_account_id: accB.body.id,
                to_account_id: accA.body.id,
                amount_paise: transferAmount,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - startBA,
              }))
          );
        }

        const responses = await Promise.all(tasks);
        const metrics = computeMetrics(responses);

        // Verification: Deterministic lock ordering guarantees ZERO deadlocks
        expect(metrics.status500Deadlocks).toBe(0);
        expect(metrics.status500Serialization).toBe(0);
        expect(metrics.status201).toBe(50); // All 50 succeed

        // Both accounts should have identical balance of 200,000 (25k sent, 25k received)
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

  describe('3. Concurrent Credits and Debits on a Hot Pivot Account', () => {
    it(
      'should handle concurrent credits and debits to the same pivot account cleanly without balance race conditions',
      async () => {
        // Pivot account starts with 50,000 paise (₹500.00)
        const pivotAcc = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Central Pivot Wallet',
            currency: 'INR',
            initial_credit_paise: 50000,
          });

        // 5 Supplier accounts (each with 50,000 paise)
        const suppliers = [];
        for (let i = 0; i < 5; i++) {
          const supp = await request(app)
            .post('/accounts')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .send({
              owner_name: `Supplier ${i + 1}`,
              currency: 'INR',
              initial_credit_paise: 50000,
            });
          suppliers.push(supp.body.id);
        }

        // 5 Consumer accounts (each with 0 paise)
        const consumers = [];
        for (let i = 0; i < 5; i++) {
          const cons = await request(app)
            .post('/accounts')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .send({
              owner_name: `Consumer ${i + 1}`,
              currency: 'INR',
              initial_credit_paise: 0,
            });
          consumers.push(cons.body.id);
        }

        const tasks = [];
        const transferUnit = 10000; // ₹100.00 each

        // 10 credits into Pivot (2 from each supplier)
        for (let i = 0; i < 10; i++) {
          const suppId = suppliers[i % 5];
          const startCredit = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `pivot-credit-${i}-${uuidv4()}`)
              .send({
                from_account_id: suppId,
                to_account_id: pivotAcc.body.id,
                amount_paise: transferUnit,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - startCredit,
              }))
          );
        }

        // 10 debits from Pivot (2 to each consumer)
        for (let i = 0; i < 10; i++) {
          const consId = consumers[i % 5];
          const startDebit = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `pivot-debit-${i}-${uuidv4()}`)
              .send({
                from_account_id: pivotAcc.body.id,
                to_account_id: consId,
                amount_paise: transferUnit,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - startDebit,
              }))
          );
        }

        const responses = await Promise.all(tasks);
        const metrics = computeMetrics(responses);

        // Verification: Zero 500 errors, zero deadlocks
        expect(metrics.status500Deadlocks).toBe(0);
        expect(metrics.status500Serialization).toBe(0);

        // Check pivot balance: started with 50,000, received 10 * 10k, sent 10 * 10k -> final must be 50,000
        const finalPivot = await request(app)
          .get(`/accounts/${pivotAcc.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalPivot.body.balance_paise).toBe(50000);

        // All suppliers sent exactly 20,000 each (final: 30,000 each)
        for (const suppId of suppliers) {
          const res = await request(app)
            .get(`/accounts/${suppId}/ledger`)
            .set('Authorization', `Bearer ${DEMO_KEY}`);
          expect(res.body.balance_paise).toBe(30000);
        }

        // All consumers received exactly 20,000 each (final: 20,000 each)
        for (const consId of consumers) {
          const res = await request(app)
            .get(`/accounts/${consId}/ledger`)
            .set('Authorization', `Bearer ${DEMO_KEY}`);
          expect(res.body.balance_paise).toBe(20000);
        }
      },
      30000
    );
  });

  describe('4. High-Concurrency Idempotency Storm (Identical Key Flooding)', () => {
    it(
      'should handle 30 concurrent requests with the identical idempotency key: funds move strictly once',
      async () => {
        const accA = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Storm Alice',
            currency: 'INR',
            initial_credit_paise: 500000,
          });

        const accB = await request(app)
          .post('/accounts')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .send({
            owner_name: 'Storm Bob',
            currency: 'INR',
            initial_credit_paise: 10000,
          });

        const sharedKey = `shared-storm-key-${uuidv4()}`;
        const transferAmount = 25000; // ₹250.00
        const tasks = [];

        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', sharedKey)
              .send({
                from_account_id: accA.body.id,
                to_account_id: accB.body.id,
                amount_paise: transferAmount,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - start,
              }))
          );
        }

        const responses = await Promise.all(tasks);

        // Outcomes: exactly one or more 201s (created + replays) or 409 Conflict while in-flight
        const createdCount = responses.filter((r) => r.status === 201 && !r.body.replayed).length;
        const conflictCount = responses.filter((r) => r.status === 409).length;
        expect(createdCount + conflictCount).toBe(30);

        // Assert balances moved EXACTLY ONCE (25,000 paise deducted from A, added to B)
        const finalA = await request(app)
          .get(`/accounts/${accA.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalA.body.balance_paise).toBe(475000); // 500000 - 25000

        const finalB = await request(app)
          .get(`/accounts/${accB.body.id}/ledger`)
          .set('Authorization', `Bearer ${DEMO_KEY}`);
        expect(finalB.body.balance_paise).toBe(35000); // 10000 + 25000

        // Invariant: exactly 1 DEBIT and 1 CREDIT entry across the entire ledger for this transfer
        const txId = responses.find((r) => r.status === 201)?.body.transaction_id;
        expect(txId).toBeDefined();

        const entriesRes = await pool.query(
          `SELECT COUNT(*)::INT as count FROM ledger_entries WHERE transaction_id = $1`,
          [txId]
        );
        expect(entriesRes.rows[0].count).toBe(2);
      },
      30000
    );
  });

  describe('5. Independent Transfers Across Unrelated Accounts (Lock Independence)', () => {
    it(
      'should process 10 independent account-pair transfers concurrently with minimal cross-contention latency',
      async () => {
        const pairs: Array<{ fromId: string; toId: string }> = [];

        // Setup 10 independent pairs
        for (let i = 0; i < 10; i++) {
          const fromRes = await request(app)
            .post('/accounts')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .send({
              owner_name: `Independent Sender ${i + 1}`,
              currency: 'INR',
              initial_credit_paise: 50000,
            });

          const toRes = await request(app)
            .post('/accounts')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .send({
              owner_name: `Independent Receiver ${i + 1}`,
              currency: 'INR',
              initial_credit_paise: 10000,
            });

          pairs.push({ fromId: fromRes.body.id, toId: toRes.body.id });
        }

        const tasks = [];
        for (let i = 0; i < 10; i++) {
          const pair = pairs[i];
          const start = performance.now();
          tasks.push(
            request(app)
              .post('/transfers')
              .set('Authorization', `Bearer ${DEMO_KEY}`)
              .set('Idempotency-Key', `independent-${i}-${uuidv4()}`)
              .send({
                from_account_id: pair.fromId,
                to_account_id: pair.toId,
                amount_paise: 5000,
              })
              .then((res) => ({
                status: res.status,
                body: res.body,
                durationMs: performance.now() - start,
              }))
          );
        }

        const responses = await Promise.all(tasks);
        const metrics = computeMetrics(responses);

        // All 10 independent pairs must succeed cleanly with zero lock contention
        expect(metrics.status201).toBe(10);
        expect(metrics.status500Deadlocks).toBe(0);
        expect(metrics.status500Serialization).toBe(0);

        // Verify all 10 pairs have updated balances
        for (const pair of pairs) {
          const fromLedger = await request(app)
            .get(`/accounts/${pair.fromId}/ledger`)
            .set('Authorization', `Bearer ${DEMO_KEY}`);
          expect(fromLedger.body.balance_paise).toBe(45000); // 50000 - 5000

          const toLedger = await request(app)
            .get(`/accounts/${pair.toId}/ledger`)
            .set('Authorization', `Bearer ${DEMO_KEY}`);
          expect(toLedger.body.balance_paise).toBe(15000); // 10000 + 5000
        }
      },
      30000
    );
  });

  describe('6. Post-Stress Double-Entry & Global Balance Reconciliation', () => {
    it('should assert zero discrepancies and strict double-entry balance conservation across the entire ledger', async () => {
      // 1. Run global reconciliation report for demo merchant
      const report = await reconcileAccountBalances({ merchantId: DEMO_MERCHANT_ID });

      expect(report.status).toBe('HEALTHY');
      expect(report.discrepancies_found).toBe(0);
      expect(report.double_entry_net_discrepancy_paise).toBe(0);

      // 2. Query database directly: verify every single transfer transaction has sum(credit) - sum(debit) === 0
      const txDiscrepancyRes = await pool.query(`
        SELECT transaction_id,
               SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) AS balance
        FROM ledger_entries
        GROUP BY transaction_id
        HAVING COUNT(*) > 1 AND SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) != 0;
      `);

      expect(txDiscrepancyRes.rows).toHaveLength(0);

      // 3. Query database directly: verify every transfer transaction has exactly 1 DEBIT and 1 CREDIT
      const txEntryCountRes = await pool.query(`
        SELECT transaction_id,
               COUNT(CASE WHEN entry_type = 'DEBIT' THEN 1 END) as debits,
               COUNT(CASE WHEN entry_type = 'CREDIT' THEN 1 END) as credits
        FROM ledger_entries
        GROUP BY transaction_id
        HAVING COUNT(*) > 1 AND (
          COUNT(CASE WHEN entry_type = 'DEBIT' THEN 1 END) != 1 OR
          COUNT(CASE WHEN entry_type = 'CREDIT' THEN 1 END) != 1
        );
      `);

      expect(txEntryCountRes.rows).toHaveLength(0);
    });
  });
});
