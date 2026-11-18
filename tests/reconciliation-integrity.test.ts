import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { reconcileAccountBalances } from '../src/services/reconciliation';

const ADMIN_TOKEN = 'default-admin-token-secret-99999';

describe('Ledger Reconciliation & Financial Integrity Verification Suite', () => {
  let tenant1Id: string;
  let tenant2Id: string;
  let acc1Tenant1: string;
  let acc2Tenant1: string;
  let acc1Tenant2: string;

  const injectedTransactionIds: string[] = [];
  const injectedAccountIds: string[] = [];
  const injectedMerchantIds: string[] = [];

  beforeAll(async () => {
    // 1. Create two isolated test tenants
    tenant1Id = uuidv4();
    tenant2Id = uuidv4();
    injectedMerchantIds.push(tenant1Id, tenant2Id);

    await pool.query(`INSERT INTO merchants (id, name) VALUES ($1, 'Recon Tenant 1'), ($2, 'Recon Tenant 2')`, [
      tenant1Id,
      tenant2Id,
    ]);

    // Create API keys for tenant 1
    const key1Id = uuidv4();
    const keyPrefix = 'lf_live_rec1_';
    const keyHash = 'recon-test-hash-1';
    await pool.query(
      `INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash) VALUES ($1, $2, $3, $4)`,
      [key1Id, tenant1Id, keyPrefix, keyHash]
    );

    // 2. Create isolated test accounts
    acc1Tenant1 = uuidv4();
    acc2Tenant1 = uuidv4();
    acc1Tenant2 = uuidv4();
    injectedAccountIds.push(acc1Tenant1, acc2Tenant1, acc1Tenant2);

    await pool.query(
      `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise) VALUES
       ($1, $2, 'Alice Tenant1', 'INR', 50000),
       ($3, $2, 'Bob Tenant1', 'INR', 20000),
       ($4, $5, 'Charlie Tenant2', 'INR', 30000)`,
      [acc1Tenant1, tenant1Id, acc2Tenant1, acc1Tenant2, tenant2Id]
    );

    // Initial funding entries (1 CREDIT per account)
    const fund1Tx = uuidv4();
    const fund2Tx = uuidv4();
    const fund3Tx = uuidv4();
    injectedTransactionIds.push(fund1Tx, fund2Tx, fund3Tx);

    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
       ($1, $2, $3, 'CREDIT', 50000),
       ($4, $5, $6, 'CREDIT', 20000),
       ($7, $8, $9, 'CREDIT', 30000)`,
      [
        uuidv4(), fund1Tx, acc1Tenant1,
        uuidv4(), fund2Tx, acc2Tenant1,
        uuidv4(), fund3Tx, acc1Tenant2,
      ]
    );
  });

  afterAll(async () => {
    // Robust cleanup of all test fixtures in reverse dependency order
    if (injectedTransactionIds.length > 0) {
      await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])`, [
        injectedTransactionIds,
      ]);
    }
    if (injectedAccountIds.length > 0) {
      await pool.query(`DELETE FROM ledger_entries WHERE account_id = ANY($1::uuid[])`, [
        injectedAccountIds,
      ]);
      await pool.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [injectedAccountIds]);
    }
    if (injectedMerchantIds.length > 0) {
      await pool.query(`DELETE FROM api_keys WHERE merchant_id = ANY($1::uuid[])`, [
        injectedMerchantIds,
      ]);
      await pool.query(`DELETE FROM merchants WHERE id = ANY($1::uuid[])`, [injectedMerchantIds]);
    }
    await closePool();
    await closeRedis();
  });

  // -------------------------------------------------------------------------
  // 1. Healthy State Baseline
  // -------------------------------------------------------------------------
  it('1. should verify healthy accounts return HEALTHY with 0 discrepancies and 0 integrity violations', async () => {
    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('HEALTHY');
    expect(report.discrepancies_found).toBe(0);
    expect(report.integrity_violations_found).toBe(0);
    expect(report.double_entry_net_discrepancy_paise).toBe(0);
    expect(report.total_accounts_checked).toBe(2);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.integrity_violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 2. Tampered Account Balance Detection (Requirement 1 & 2)
  // -------------------------------------------------------------------------
  it('2. should detect stored balance desynchronization against ledger entries (BALANCE_MISMATCH)', async () => {
    const orig = Number(
      (await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [acc1Tenant1])).rows[0].balance_paise
    );

    // Deliberately tamper acc1Tenant1 balance to 99999 paise (stored != sum of entries)
    await pool.query(`UPDATE accounts SET balance_paise = 99999 WHERE id = $1`, [acc1Tenant1]);

    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('DISCREPANCY_DETECTED');
    expect(report.discrepancies_found).toBe(1);

    const disc = report.discrepancies.find((d) => d.account_id === acc1Tenant1);
    expect(disc).toBeDefined();
    expect(disc?.status).toBe('BALANCE_MISMATCH');
    expect(disc?.stored_balance_paise).toBe(99999);
    expect(disc?.calculated_balance_paise).toBe(orig);
    expect(disc?.discrepancy_paise).toBe(99999 - orig);
    expect(disc?.merchant_id).toBe(tenant1Id);

    // Restore balance for subsequent tests
    await pool.query(`UPDATE accounts SET balance_paise = $1 WHERE id = $2`, [orig, acc1Tenant1]);
  });

  // -------------------------------------------------------------------------
  // 3. Unbalanced Transfer Detection (Requirement 3 & 4)
  // -------------------------------------------------------------------------
  it('3. should detect unbalanced transfers where sum(DEBIT) != sum(CREDIT) (UNBALANCED_TRANSFER)', async () => {
    const unbalTxId = uuidv4();
    injectedTransactionIds.push(unbalTxId);

    // Insert an unbalanced transfer: DEBIT 10000 on Alice, but CREDIT 7000 on Bob (loss of 3000 paise)
    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
       ($1, $2, $3, 'DEBIT', 10000),
       ($4, $2, $5, 'CREDIT', 7000)`,
      [uuidv4(), unbalTxId, acc1Tenant1, uuidv4(), acc2Tenant1]
    );

    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('DISCREPANCY_DETECTED');
    expect(report.integrity_violations_found).toBeGreaterThanOrEqual(1);

    const violation = report.integrity_violations.find(
      (v) => v.transaction_id === unbalTxId && v.violation_type === 'UNBALANCED_TRANSFER'
    );
    expect(violation).toBeDefined();
    expect(violation?.debit_paise).toBe(10000);
    expect(violation?.credit_paise).toBe(7000);
    expect(violation?.imbalance_paise).toBe(3000);
    expect(violation?.affected_accounts).toEqual(expect.arrayContaining([acc1Tenant1, acc2Tenant1]));

    // Clean up unbalanced entries
    await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [unbalTxId]);
  });

  // -------------------------------------------------------------------------
  // 4. Missing Counterpart Detection (Requirement 4)
  // -------------------------------------------------------------------------
  it('4. should detect missing counterparts when a transfer has debit without credit (MISSING_COUNTERPART)', async () => {
    const orphanedTxId = uuidv4();
    injectedTransactionIds.push(orphanedTxId);

    // Insert orphaned DEBIT (funds left Alice but never reached any destination)
    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
       ($1, $2, $3, 'DEBIT', 5000)`,
      [uuidv4(), orphanedTxId, acc1Tenant1]
    );

    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('DISCREPANCY_DETECTED');

    const violation = report.integrity_violations.find(
      (v) => v.transaction_id === orphanedTxId && v.violation_type === 'MISSING_COUNTERPART'
    );
    expect(violation).toBeDefined();
    expect(violation?.details).toContain('Missing opposite entry leg');
    expect(violation?.affected_accounts).toContain(acc1Tenant1);

    // Clean up
    await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [orphanedTxId]);
  });

  // -------------------------------------------------------------------------
  // 5. Duplicate Entries Detection (Requirement 4)
  // -------------------------------------------------------------------------
  it('5. should detect duplicate entries for the same account under a single transaction ID (DUPLICATE_ENTRIES)', async () => {
    const dupTxId = uuidv4();
    injectedTransactionIds.push(dupTxId);

    // Temporarily drop unique constraint to simulate corrupted or replayed data
    await pool.query(`ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS uq_ledger_entries_transaction_account`);
    try {
      await pool.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
         ($1, $2, $3, 'DEBIT', 4000),
         ($4, $2, $3, 'DEBIT', 4000),
         ($5, $2, $6, 'CREDIT', 8000)`,
        [uuidv4(), dupTxId, acc1Tenant1, uuidv4(), uuidv4(), acc2Tenant1]
      );

      const report = await reconcileAccountBalances({ merchantId: tenant1Id });
      expect(report.status).toBe('DISCREPANCY_DETECTED');

      const violation = report.integrity_violations.find(
        (v) => v.transaction_id === dupTxId && v.violation_type === 'DUPLICATE_ENTRIES'
      );
      expect(violation).toBeDefined();
      expect(violation?.affected_accounts).toContain(acc1Tenant1);
    } finally {
      await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [dupTxId]);
      await pool.query(
        `ALTER TABLE ledger_entries ADD CONSTRAINT uq_ledger_entries_transaction_account UNIQUE (transaction_id, account_id)`
      );
    }
  });

  // -------------------------------------------------------------------------
  // 6. Malformed Ledger Record Detection (Requirement 4)
  // -------------------------------------------------------------------------
  it('6. should detect malformed ledger records violating invariants (MALFORMED_RECORD)', async () => {
    const malformedTxId = uuidv4();
    injectedTransactionIds.push(malformedTxId);

    // Temporarily drop max safe check constraint to simulate corrupted data
    await pool.query(`ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS chk_ledger_entries_amount_max_safe`);
    try {
      const unsafeAmount = '9007199254740992'; // MAX_SAFE_PAISE + 1
      await pool.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
         ($1, $2, $3, 'CREDIT', $4)`,
        [uuidv4(), malformedTxId, acc1Tenant1, unsafeAmount]
      );

      const report = await reconcileAccountBalances({ merchantId: tenant1Id });
      expect(report.status).toBe('DISCREPANCY_DETECTED');

      const violation = report.integrity_violations.find(
        (v) => v.transaction_id === malformedTxId && v.violation_type === 'MALFORMED_RECORD'
      );
      expect(violation).toBeDefined();
      expect(violation?.details).toContain('EXCEEDS_MAX_SAFE_PAISE');
    } finally {
      await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [malformedTxId]);
      await pool.query(
        `ALTER TABLE ledger_entries ADD CONSTRAINT chk_ledger_entries_amount_max_safe CHECK (amount <= 9007199254740991)`
      );
    }
  });

  // -------------------------------------------------------------------------
  // 7. Cross-Tenant Leakage Detection (Requirement 4 & 5)
  // -------------------------------------------------------------------------
  it('7. should detect cross-tenant leakage where a transaction spans multiple merchants (CROSS_TENANT_LEAKAGE)', async () => {
    const crossTxId = uuidv4();
    injectedTransactionIds.push(crossTxId);

    // Insert a transfer linking acc1Tenant1 (Tenant 1) and acc1Tenant2 (Tenant 2)
    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
       ($1, $2, $3, 'DEBIT', 2500),
       ($4, $2, $5, 'CREDIT', 2500)`,
      [uuidv4(), crossTxId, acc1Tenant1, uuidv4(), acc1Tenant2]
    );

    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('DISCREPANCY_DETECTED');

    const violation = report.integrity_violations.find(
      (v) => v.transaction_id === crossTxId && v.violation_type === 'CROSS_TENANT_LEAKAGE'
    );
    expect(violation).toBeDefined();
    expect(violation?.affected_accounts).toEqual(
      expect.arrayContaining([acc1Tenant1, acc1Tenant2])
    );

    // Clean up
    await pool.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [crossTxId]);
  });

  // -------------------------------------------------------------------------
  // 8. Tenant & Account Scoping Isolation (Requirement 5)
  // -------------------------------------------------------------------------
  it('8. should isolate reconciliation strictly by merchant_id and account_id', async () => {
    const origTenant2 = Number(
      (await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [acc1Tenant2])).rows[0].balance_paise
    );

    // Tamper Tenant 2's account balance
    await pool.query(`UPDATE accounts SET balance_paise = 99999 WHERE id = $1`, [acc1Tenant2]);

    // Reconciling Tenant 1 MUST remain completely unaffected (HEALTHY)
    const tenant1Report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(tenant1Report.status).toBe('HEALTHY');
    expect(tenant1Report.discrepancies_found).toBe(0);

    // Reconciling Tenant 2 MUST detect the discrepancy
    const tenant2Report = await reconcileAccountBalances({ merchantId: tenant2Id });
    expect(tenant2Report.status).toBe('DISCREPANCY_DETECTED');
    expect(tenant2Report.discrepancies_found).toBe(1);
    expect(tenant2Report.discrepancies[0].account_id).toBe(acc1Tenant2);

    // Scoping by account_id on acc2Tenant1 (healthy) should return HEALTHY
    const acc2Report = await reconcileAccountBalances({ accountId: acc2Tenant1 });
    expect(acc2Report.status).toBe('HEALTHY');
    expect(acc2Report.discrepancies_found).toBe(0);

    // Scoping by account_id on acc1Tenant2 (tampered) should detect the discrepancy
    const acc1Tenant2Report = await reconcileAccountBalances({ accountId: acc1Tenant2 });
    expect(acc1Tenant2Report.status).toBe('DISCREPANCY_DETECTED');
    expect(acc1Tenant2Report.discrepancies_found).toBe(1);

    // Restore Tenant 2 account balance
    await pool.query(`UPDATE accounts SET balance_paise = $1 WHERE id = $2`, [origTenant2, acc1Tenant2]);
  });

  // -------------------------------------------------------------------------
  // 9. Read-Only Invariant Enforcement (Requirement 6)
  // -------------------------------------------------------------------------
  it('9. should ensure reconciliation is strictly read-only and never silently mutates records', async () => {
    const orig = Number(
      (await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [acc1Tenant1])).rows[0].balance_paise
    );

    // Deliberately tamper balance
    await pool.query(`UPDATE accounts SET balance_paise = 88888 WHERE id = $1`, [acc1Tenant1]);

    // Call reconciliation with default options (autoRepair = false)
    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.status).toBe('DISCREPANCY_DETECTED');

    // Confirm stored database value was NOT mutated or repaired
    const checkRes = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [
      acc1Tenant1,
    ]);
    expect(Number(checkRes.rows[0].balance_paise)).toBe(88888);

    // Restore balance
    await pool.query(`UPDATE accounts SET balance_paise = $1 WHERE id = $2`, [orig, acc1Tenant1]);
  });

  // -------------------------------------------------------------------------
  // 10. Point-in-Time Snapshot Isolation Under Concurrency (Requirement 7)
  // -------------------------------------------------------------------------
  it('10. should maintain snapshot consistency under concurrent in-flight transfers without false positives', async () => {
    // Fire 5 transfers between Alice and Bob while executing reconciliation simultaneously
    const transferPromises = Array.from({ length: 5 }, async () => {
      const txId = uuidv4();
      injectedTransactionIds.push(txId);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE accounts SET balance_paise = balance_paise - 100 WHERE id = $1`, [
          acc1Tenant1,
        ]);
        await client.query(`UPDATE accounts SET balance_paise = balance_paise + 100 WHERE id = $1`, [
          acc2Tenant1,
        ]);
        await client.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount) VALUES
           ($1, $2, $3, 'DEBIT', 100),
           ($4, $2, $5, 'CREDIT', 100)`,
          [uuidv4(), txId, acc1Tenant1, uuidv4(), acc2Tenant1]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    const reconcilePromise = reconcileAccountBalances({ merchantId: tenant1Id });

    const [report] = await Promise.all([reconcilePromise, ...transferPromises]);

    // Snapshot isolation guarantees no transient intermediate state causes false discrepancy
    expect(report.status).toBe('HEALTHY');
    expect(report.discrepancies_found).toBe(0);
    expect(report.integrity_violations_found).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 11. Structured Discrepancy Schema & Sensitive Data Filtering (Requirement 8)
  // -------------------------------------------------------------------------
  it('11. should provide structured discrepancy output without leaking sensitive credentials or keys', async () => {
    const orig = Number(
      (await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [acc1Tenant1])).rows[0].balance_paise
    );

    await pool.query(`UPDATE accounts SET balance_paise = 11111 WHERE id = $1`, [acc1Tenant1]);

    const report = await reconcileAccountBalances({ merchantId: tenant1Id });
    expect(report.discrepancies_found).toBe(1);

    const discrepancy = report.discrepancies[0];
    // Verify required audit fields are present
    expect(discrepancy).toHaveProperty('account_id');
    expect(discrepancy).toHaveProperty('merchant_id');
    expect(discrepancy).toHaveProperty('owner_name');
    expect(discrepancy).toHaveProperty('stored_balance_paise');
    expect(discrepancy).toHaveProperty('calculated_balance_paise');
    expect(discrepancy).toHaveProperty('discrepancy_paise');

    // Verify sensitive data is NOT present
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('key_hash');
    expect(serialized).not.toContain('secret');

    // Restore balance to exact orig
    await pool.query(`UPDATE accounts SET balance_paise = $1 WHERE id = $2`, [orig, acc1Tenant1]);
  });

  // -------------------------------------------------------------------------
  // 12. HTTP Admin Reconcile Endpoint with Scoping Parameters (Requirement 5 & 10)
  // -------------------------------------------------------------------------
  it('12. should support tenant and account scoping via POST /admin/reconcile', async () => {
    const res = await request(app)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({
        merchant_id: tenant1Id,
        account_id: acc1Tenant1,
        auto_repair: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HEALTHY');
    expect(res.body.total_accounts_checked).toBe(1);
    expect(res.body.discrepancies_found).toBe(0);
  });
});
