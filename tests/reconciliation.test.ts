import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { reconcileAccountBalances } from '../src/services/reconciliation';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_TOKEN = 'default-admin-token-secret-99999';

describe('Account Balance Caching & Reconciliation Suite', () => {
  let testAccountId: string;

  beforeAll(async () => {
    testAccountId = uuidv4();
    await pool.query(
      `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise)
       VALUES ($1, $2, 'Reconciliation Test User', 'INR', 10000)`,
      [testAccountId, DEMO_MERCHANT_ID]
    );
    await pool.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, $3, 'CREDIT', 10000)`,
      [uuidv4(), uuidv4(), testAccountId]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM ledger_entries WHERE account_id = $1`, [testAccountId]);
    await pool.query(`DELETE FROM accounts WHERE id = $1`, [testAccountId]);
    await closePool();
    await closeRedis();
  });

  it('should verify that healthy accounts have 0 balance discrepancy', async () => {
    const report = await reconcileAccountBalances({ merchantId: DEMO_MERCHANT_ID });
    expect(report.status).toBe('HEALTHY');
    expect(report.discrepancies_found).toBe(0);
    expect(report.double_entry_net_discrepancy_paise).toBe(0);
  });

  it('should detect when an account balance is tampered or desynchronized', async () => {
    // Tamper cached balance to 15,000 paise while ledger entries sum to 10,000
    await pool.query(
      `UPDATE accounts SET balance_paise = 15000 WHERE id = $1`,
      [testAccountId]
    );

    const report = await reconcileAccountBalances({ merchantId: DEMO_MERCHANT_ID });
    expect(report.status).toBe('DISCREPANCY_DETECTED');
    expect(report.discrepancies_found).toBeGreaterThanOrEqual(1);

    const matching = report.discrepancies.find((d) => d.account_id === testAccountId);
    expect(matching).toBeDefined();
    expect(matching?.cached_balance_paise).toBe(15000);
    expect(matching?.computed_balance_paise).toBe(10000);
    expect(matching?.discrepancy_paise).toBe(5000);
  });

  it('should automatically repair desynchronized account balance when autoRepair is enabled', async () => {
    const repairReport = await reconcileAccountBalances({
      merchantId: DEMO_MERCHANT_ID,
      autoRepair: true,
    });
    expect(repairReport.discrepancies_found).toBeGreaterThanOrEqual(1);

    // Verify account balance in database was restored to match ledger SUM (10,000)
    const checkRes = await pool.query(
      `SELECT balance_paise FROM accounts WHERE id = $1`,
      [testAccountId]
    );
    expect(Number(checkRes.rows[0].balance_paise)).toBe(10000);

    // Second run must be clean
    const postRepair = await reconcileAccountBalances({ merchantId: DEMO_MERCHANT_ID });
    expect(postRepair.discrepancies_found).toBe(0);
    expect(postRepair.status).toBe('HEALTHY');
  });

  it('should trigger reconciliation via POST /admin/reconcile with ADMIN_TOKEN', async () => {
    const res = await request(app)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ auto_repair: false });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HEALTHY');
    expect(res.body.total_accounts_checked).toBeGreaterThanOrEqual(1);
    expect(res.body.double_entry_net_discrepancy_paise).toBe(0);
  });

  it('should reject unauthorized calls to POST /admin/reconcile with 401', async () => {
    const res = await request(app)
      .post('/admin/reconcile')
      .send({ auto_repair: false });

    expect(res.status).toBe(401);
  });
});
