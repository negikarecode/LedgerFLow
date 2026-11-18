import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { createTransfer } from '../src/api/controllers/transfers.controller';
import { Request, Response } from 'express';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('Same-Account Transfer Prevention & Hardening Suite', () => {
  const ADMIN_TOKEN = 'default-admin-token-secret-99999';
  let merchantOneAccountA: string;
  let merchantOneAccountB: string;
  let merchantTwoAccount: string;
  let merchantTwoKey: string;
  let foreignMerchantId: string;

  beforeAll(async () => {
    // 1. Create two accounts for Merchant 1 (Demo Merchant)
    const acc1Res = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${DEMO_KEY}`)
      .send({
        owner_name: 'Merchant 1 Wallet A',
        currency: 'INR',
        initial_credit_paise: 100000, // ₹1,000.00
      });
    merchantOneAccountA = acc1Res.body.id;

    const acc2Res = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${DEMO_KEY}`)
      .send({
        owner_name: 'Merchant 1 Wallet B',
        currency: 'INR',
        initial_credit_paise: 50000, // ₹500.00
      });
    merchantOneAccountB = acc2Res.body.id;

    // 2. Create Merchant 2 via Admin API and an account for Merchant 2
    const m2Res = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ name: 'Merchant Two Corp' });

    merchantTwoKey = m2Res.body.api_key.key;
    foreignMerchantId = m2Res.body.merchant.id;

    const m2AccRes = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${merchantTwoKey}`)
      .send({
        owner_name: 'Merchant 2 Foreign Wallet',
        currency: 'INR',
        initial_credit_paise: 200000,
      });
    expect(m2AccRes.status).toBe(201);
    merchantTwoAccount = m2AccRes.body.id;
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('1. Rejection of Same-Account Transfers on Existent Accounts', () => {
    it('should reject transfer when from_account_id equals to_account_id with 400 Validation failed', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: merchantOneAccountA,
          to_account_id: merchantOneAccountA,
          amount_paise: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('to_account_id');
      expect(res.body.details[0].message).toBe(
        'from_account_id and to_account_id must not be the same'
      );
    });

    it('should reject transfer with alternative alias field names (source_account_id === destination_account_id)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          source_account_id: merchantOneAccountA,
          destination_account_id: merchantOneAccountA,
          amount_paise: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].message).toContain('must not be the same');
    });

    it('should reject mixed field names referring to the same account (from_account_id === destination_account_id)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: merchantOneAccountA,
          destination_account_id: merchantOneAccountA,
          to_account_id: merchantOneAccountB,
          amount_paise: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].message).toContain('must not be the same');
    });
  });

  describe('2. Bypassing Resistance: Case and Whitespace Manipulation', () => {
    it('should reject same-account transfer with uppercase vs lowercase UUID', async () => {
      const upperId = merchantOneAccountA.toUpperCase();
      const lowerId = merchantOneAccountA.toLowerCase();

      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: lowerId,
          to_account_id: upperId,
          amount_paise: 5000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('to_account_id');
      expect(res.body.details[0].message).toContain('must not be the same');
    });

    it('should reject same-account transfer with leading/trailing whitespace manipulation', async () => {
      const paddedId = `   ${merchantOneAccountA}   `;

      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: paddedId,
          to_account_id: merchantOneAccountA,
          amount_paise: 5000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('to_account_id');
      expect(res.body.details[0].message).toContain('must not be the same');
    });
  });

  describe('3. Nonexistent and Cross-Tenant Account Structural Rejection', () => {
    it('should reject same-account transfer with 400 even if the account does NOT exist', async () => {
      const nonExistentId = uuidv4();
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: nonExistentId,
          to_account_id: nonExistentId,
          amount_paise: 1000,
        });

      // Must fail with 400 Validation error, not 404, because structural identity is checked before DB lookup
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].message).toContain('must not be the same');
    });

    it('should reject same-account transfer with 400 when the account belongs to another merchant', async () => {
      // Merchant 1 attempts transfer from Merchant 2's account to Merchant 2's account
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: merchantTwoAccount,
          to_account_id: merchantTwoAccount,
          amount_paise: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].message).toContain('must not be the same');
    });

    it('should return 404 Not Found for cross-tenant transfer between different accounts', async () => {
      // Merchant 1 attempts transfer from their account to Merchant 2's account
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: merchantOneAccountA,
          to_account_id: merchantTwoAccount,
          amount_paise: 1000,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body.message).toContain('One or both accounts not found');
    });
  });

  describe('4. Non-Mutation Guarantee: Zero Balance Changes, Ledger Entries, or Outbox Events', () => {
    it('should leave database balances, ledger, and outbox strictly unmodified on rejected self-transfer', async () => {
      // Record baseline
      const beforeAcc = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [
        merchantOneAccountA,
      ]);
      const beforeLedgerCount = await pool.query(
        `SELECT COUNT(*)::INT as count FROM ledger_entries WHERE account_id = $1`,
        [merchantOneAccountA]
      );
      const beforeOutboxCount = await pool.query(`SELECT COUNT(*)::INT as count FROM outbox_events`);

      const initialBalance = beforeAcc.rows[0].balance_paise;
      const initialLedger = beforeLedgerCount.rows[0].count;
      const initialOutbox = beforeOutboxCount.rows[0].count;

      // Execute rejected same-account transfer
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: merchantOneAccountA,
          to_account_id: merchantOneAccountA,
          amount_paise: 25000,
        });

      expect(res.status).toBe(400);

      // Verify baseline unchanged
      const afterAcc = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [
        merchantOneAccountA,
      ]);
      const afterLedgerCount = await pool.query(
        `SELECT COUNT(*)::INT as count FROM ledger_entries WHERE account_id = $1`,
        [merchantOneAccountA]
      );
      const afterOutboxCount = await pool.query(`SELECT COUNT(*)::INT as count FROM outbox_events`);

      expect(afterAcc.rows[0].balance_paise).toBe(initialBalance);
      expect(afterLedgerCount.rows[0].count).toBe(initialLedger);
      expect(afterOutboxCount.rows[0].count).toBe(initialOutbox);
    });
  });

  describe('5. High Concurrency Invariant: Concurrent Self-Transfer Flooding', () => {
    it('should deterministically reject 20 concurrent self-transfer requests with zero side-effects', async () => {
      const concurrentRequests = [];
      for (let i = 0; i < 20; i++) {
        concurrentRequests.push(
          request(app)
            .post('/transfers')
            .set('Authorization', `Bearer ${DEMO_KEY}`)
            .set('Idempotency-Key', `self-transfer-conc-${i}-${uuidv4()}`)
            .send({
              from_account_id: merchantOneAccountA,
              to_account_id: merchantOneAccountA,
              amount_paise: 1000,
            })
        );
      }

      const results = await Promise.all(concurrentRequests);

      // Assert all 20 returned 400
      for (const res of results) {
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
        expect(res.body.details[0].message).toContain('must not be the same');
      }

      // Assert account balance unchanged (still 100,000 paise)
      const balanceCheck = await pool.query(
        `SELECT balance_paise FROM accounts WHERE id = $1`,
        [merchantOneAccountA]
      );
      expect(Number(balanceCheck.rows[0].balance_paise)).toBe(100000);
    });
  });

  describe('6. Direct Controller Unit Test (Pipeline Bypass Protection)', () => {
    it('should reject same-account transfer directly inside createTransfer controller before acquiring DB client', async () => {
      let responseStatus: number | null = null;
      let responseBody: any = null;

      const mockReq = {
        body: {
          from_account_id: merchantOneAccountA,
          to_account_id: merchantOneAccountA,
          amount_paise: 1000,
        },
        merchant: { id: DEMO_MERCHANT_ID },
        headers: {},
      } as unknown as Request;

      const mockRes = {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json(body: any) {
          responseBody = body;
          return this;
        },
      } as unknown as Response;

      const next = () => {};

      await createTransfer(mockReq, mockRes, next);

      expect(responseStatus).toBe(400);
      expect(responseBody).toEqual({
        error: 'Validation failed',
        details: [
          {
            field: 'to_account_id',
            message: 'from_account_id and to_account_id must not be the same',
          },
        ],
      });
    });
  });

  describe('7. PostgreSQL Database Engine Constraint Enforcement', () => {
    it('should reject direct SQL INSERT of both DEBIT and CREDIT on the same account under the same transaction_id', async () => {
      const txId = uuidv4();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // First entry succeeds
        await client.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
           VALUES ($1, $2, $3, 'DEBIT', 5000)`,
          [uuidv4(), txId, merchantOneAccountA]
        );

        // Second entry on the same account and transaction_id must violate unique constraint
        await expect(
          client.query(
            `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
             VALUES ($1, $2, $3, 'CREDIT', 5000)`,
            [uuidv4(), txId, merchantOneAccountA]
          )
        ).rejects.toThrow(/uq_ledger_entries_transaction_account/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
