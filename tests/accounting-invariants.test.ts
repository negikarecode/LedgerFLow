import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { MAX_SAFE_PAISE } from '../src/api/schemas/transfer.schema';
import { reconcileAccountBalances } from '../src/services/reconciliation';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

describe('Financial Amount Validation & Accounting Invariants Suite', () => {
  let senderAccountId: string;
  let receiverAccountId: string;

  beforeAll(async () => {
    // Create base accounts for testing
    const senderRes = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${DEMO_KEY}`)
      .send({
        owner_name: 'Invariant Sender',
        currency: 'INR',
        initial_credit_paise: 500000, // ₹5,000.00
      });
    senderAccountId = senderRes.body.id;

    const receiverRes = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${DEMO_KEY}`)
      .send({
        owner_name: 'Invariant Receiver',
        currency: 'INR',
        initial_credit_paise: 100000, // ₹1,000.00
      });
    receiverAccountId = receiverRes.body.id;
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('1. Amount Schema Rejection Boundaries (400 Bad Request)', () => {
    it('should reject zero amount_paise (0)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
      expect(res.body.details[0].message).toContain('greater than 0');
    });

    it('should reject negative amount_paise (-500)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: -500,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
      expect(res.body.details[0].message).toContain('greater than 0');
    });

    it('should reject decimal amounts (e.g. 10.50 paise)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 10.5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
      expect(res.body.details[0].message).toContain('must be an integer');
    });

    it('should reject sub-paise amounts (e.g. 0.99 paise)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 0.99,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
      expect(res.body.details[0].message).toContain('must be an integer');
    });

    it('should reject string amounts (e.g. "1000")', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: '1000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
      expect(res.body.details[0].message).toContain('must be a valid number');
    });

    it('should reject formatted currency strings (e.g. "1,000", "$50")', async () => {
      const formattedInputs = ['1,000', '$50', '₹100', '100.00'];
      for (const input of formattedInputs) {
        const res = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', uuidv4())
          .send({
            from_account_id: senderAccountId,
            to_account_id: receiverAccountId,
            amount_paise: input,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      }
    });

    it('should reject unsafe JavaScript integers exceeding Number.MAX_SAFE_INTEGER', async () => {
      // 9007199254740992 = 2^53, 1 above MAX_SAFE_INTEGER
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 9007199254740992,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
    });

    it('should reject astronomical float representation (1e20)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 1e20,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('amount_paise');
    });

    it('should reject non-numeric values (boolean, null, object, array)', async () => {
      const invalidValues = [true, false, null, {}, [100]];
      for (const val of invalidValues) {
        const res = await request(app)
          .post('/transfers')
          .set('Authorization', `Bearer ${DEMO_KEY}`)
          .set('Idempotency-Key', uuidv4())
          .send({
            from_account_id: senderAccountId,
            to_account_id: receiverAccountId,
            amount_paise: val,
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Validation failed');
      }
    });
  });

  describe('2. Account Creation Initial Credit Validation', () => {
    it('should reject string initial_credit_paise ("5000")', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Invalid String User',
          currency: 'INR',
          initial_credit_paise: '5000',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('initial_credit_paise');
      expect(res.body.details[0].message).toContain('must be a valid number');
    });

    it('should reject negative initial_credit_paise', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Negative User',
          currency: 'INR',
          initial_credit_paise: -1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('initial_credit_paise');
    });

    it('should reject decimal initial_credit_paise (100.5)', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Decimal User',
          currency: 'INR',
          initial_credit_paise: 100.5,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('initial_credit_paise');
    });

    it('should reject unsafe integer initial_credit_paise (> MAX_SAFE_INTEGER)', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Unsafe User',
          currency: 'INR',
          initial_credit_paise: 9007199254740992,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('initial_credit_paise');
    });

    it('should accept 0 initial_credit_paise', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Zero Balance User',
          currency: 'INR',
          initial_credit_paise: 0,
        });

      expect(res.status).toBe(201);
      expect(res.body.balance_paise).toBe(0);
      expect(res.body.initial_transaction_id).toBeNull();
    });
  });

  describe('3. Minimum and Maximum Safe Integer Transfers', () => {
    it('should successfully execute a minimum transfer of 1 paise', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 1,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.amount_paise).toBe(1);
    });

    it('should successfully handle maximum safe integer amount (Number.MAX_SAFE_INTEGER)', async () => {
      // 1. Create whale sender with Number.MAX_SAFE_INTEGER balance
      const maxPaise = MAX_SAFE_PAISE; // 9007199254740991
      const whaleSender = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Whale Sender',
          currency: 'INR',
          initial_credit_paise: maxPaise,
        });
      expect(whaleSender.status).toBe(201);
      expect(whaleSender.body.balance_paise).toBe(maxPaise);

      // 2. Create empty recipient
      const emptyReceiver = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Empty Receiver',
          currency: 'INR',
          initial_credit_paise: 0,
        });
      expect(emptyReceiver.status).toBe(201);
      expect(emptyReceiver.body.balance_paise).toBe(0);

      // 3. Transfer entire max safe amount
      const transferRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: whaleSender.body.id,
          to_account_id: emptyReceiver.body.id,
          amount_paise: maxPaise,
        });

      expect(transferRes.status).toBe(201);
      expect(transferRes.body.amount_paise).toBe(maxPaise);

      // 4. Verify sender has 0 and receiver has maxPaise
      const senderLedger = await request(app)
        .get(`/accounts/${whaleSender.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(senderLedger.body.balance_paise).toBe(0);

      const receiverLedger = await request(app)
        .get(`/accounts/${emptyReceiver.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(receiverLedger.body.balance_paise).toBe(maxPaise);
    });
  });

  describe('4. Recipient Balance Overflow Protection (422)', () => {
    it('should reject transfer with 422 if recipient balance would exceed Number.MAX_SAFE_INTEGER', async () => {
      // 1. Create recipient close to MAX_SAFE_PAISE
      const almostMax = MAX_SAFE_PAISE - 100;
      const richReceiver = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          owner_name: 'Near-Cap Receiver',
          currency: 'INR',
          initial_credit_paise: almostMax,
        });
      expect(richReceiver.status).toBe(201);

      // 2. Sender attempts to send 200 paise, which would exceed MAX_SAFE_PAISE by 100
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: richReceiver.body.id,
          amount_paise: 200,
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Unprocessable Entity');
      expect(res.body.message).toContain('Transfer would exceed maximum supported account balance');

      // 3. Verify recipient balance was NOT modified
      const ledger = await request(app)
        .get(`/accounts/${richReceiver.body.id}/ledger`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
      expect(ledger.body.balance_paise).toBe(almostMax);
    });
  });

  describe('5. Double-Entry Accounting Zero-Sum Invariant', () => {
    it('should assert sum of debits and credits equals zero for each completed transfer', async () => {
      const transferAmount = 15000; // ₹150.00
      const transferRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: transferAmount,
        });

      expect(transferRes.status).toBe(201);
      const transactionId = transferRes.body.transaction_id;

      // Query database directly for immutable ledger entries of this transaction
      const entriesRes = await pool.query(
        `SELECT entry_type, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY entry_type`,
        [transactionId]
      );

      expect(entriesRes.rows).toHaveLength(2);

      const debit = entriesRes.rows.find((r) => r.entry_type === 'DEBIT');
      const credit = entriesRes.rows.find((r) => r.entry_type === 'CREDIT');

      expect(debit).toBeDefined();
      expect(credit).toBeDefined();

      const debitAmount = BigInt(debit.amount);
      const creditAmount = BigInt(credit.amount);

      expect(debitAmount).toBe(BigInt(transferAmount));
      expect(creditAmount).toBe(BigInt(transferAmount));

      // Mathematical conservation check: CREDIT - DEBIT === 0
      expect(creditAmount - debitAmount).toBe(0n);
    });
  });

  describe('6. Rejection Atomicity & Non-Mutation Guarantees', () => {
    it('should guarantee rejected transfers (400, 404, 422) modify zero balances, ledger entries, or outbox events', async () => {
      // 1. Snapshot database counts and balances
      const beforeSender = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [senderAccountId]);
      const beforeReceiver = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [receiverAccountId]);
      const beforeLedgerCount = await pool.query(`SELECT COUNT(*)::INT as count FROM ledger_entries`);
      const beforeOutboxCount = await pool.query(`SELECT COUNT(*)::INT as count FROM outbox_events`);

      const initialSenderBalance = beforeSender.rows[0].balance_paise;
      const initialReceiverBalance = beforeReceiver.rows[0].balance_paise;
      const initialLedger = beforeLedgerCount.rows[0].count;
      const initialOutbox = beforeOutboxCount.rows[0].count;

      // Attempt 1: 400 Validation error (decimal amount)
      await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 12.34,
        });

      // Attempt 2: 404 Account not found
      await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: uuidv4(),
          amount_paise: 5000,
        });

      // Attempt 3: 422 Insufficient funds
      await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .set('Idempotency-Key', uuidv4())
        .send({
          from_account_id: senderAccountId,
          to_account_id: receiverAccountId,
          amount_paise: 9999999999, // Exceeds balance
        });

      // 2. Assert zero state mutations across the board
      const afterSender = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [senderAccountId]);
      const afterReceiver = await pool.query(`SELECT balance_paise FROM accounts WHERE id = $1`, [receiverAccountId]);
      const afterLedgerCount = await pool.query(`SELECT COUNT(*)::INT as count FROM ledger_entries`);
      const afterOutboxCount = await pool.query(`SELECT COUNT(*)::INT as count FROM outbox_events`);

      expect(afterSender.rows[0].balance_paise).toBe(initialSenderBalance);
      expect(afterReceiver.rows[0].balance_paise).toBe(initialReceiverBalance);
      expect(afterLedgerCount.rows[0].count).toBe(initialLedger);
      expect(afterOutboxCount.rows[0].count).toBe(initialOutbox);
    });
  });

  describe('7. PostgreSQL Database Level Constraints Protection', () => {
    it('should reject direct SQL INSERT of negative balance into accounts table', async () => {
      await expect(
        pool.query(
          `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise)
           VALUES ($1, $2, 'Negative DB User', 'INR', -100)`,
          [uuidv4(), DEMO_MERCHANT_ID]
        )
      ).rejects.toThrow(/chk_accounts_balance_non_negative/);
    });

    it('should reject direct SQL INSERT of balance exceeding Number.MAX_SAFE_INTEGER into accounts table', async () => {
      await expect(
        pool.query(
          `INSERT INTO accounts (id, merchant_id, owner_name, currency, balance_paise)
           VALUES ($1, $2, 'Overflow DB User', 'INR', 9007199254740992)`,
          [uuidv4(), DEMO_MERCHANT_ID]
        )
      ).rejects.toThrow(/chk_accounts_balance_max_safe/);
    });

    it('should reject direct SQL INSERT of amount <= 0 into ledger_entries table', async () => {
      await expect(
        pool.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
           VALUES ($1, $2, $3, 'CREDIT', 0)`,
          [uuidv4(), uuidv4(), senderAccountId]
        )
      ).rejects.toThrow(/ledger_entries_amount_check/);
    });

    it('should reject direct SQL INSERT of amount exceeding Number.MAX_SAFE_INTEGER into ledger_entries table', async () => {
      await expect(
        pool.query(
          `INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
           VALUES ($1, $2, $3, 'CREDIT', 9007199254740992)`,
          [uuidv4(), uuidv4(), senderAccountId]
        )
      ).rejects.toThrow(/chk_ledger_entries_amount_max_safe/);
    });
  });

  describe('8. Overall System Reconciliation Invariant Verification', () => {
    it('should report HEALTHY status and exactly 0 net discrepancy across all accounts', async () => {
      const report = await reconcileAccountBalances({ merchantId: DEMO_MERCHANT_ID });
      expect(report.status).toBe('HEALTHY');
      expect(report.discrepancies_found).toBe(0);
      expect(report.double_entry_net_discrepancy_paise).toBe(0);
    });
  });
});
