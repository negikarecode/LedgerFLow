import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient, query } from '../../db/pool';
import { env } from '../../config/env';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

function getEffectiveMerchantId(req: Request, res: Response): string | null {
  const isProduction = env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';
  const merchantId = req.merchant?.id || (!isProduction ? DEFAULT_DEMO_MERCHANT_ID : null);
  if (!merchantId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Merchant authentication required',
    });
    return null;
  }
  return merchantId;
}

export async function createAccount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { owner_name, currency, initial_credit_paise } = req.body;
  const merchantId = getEffectiveMerchantId(req, res);
  if (!merchantId) return;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Insert Account scoped to authenticated merchant
    const initialPaise = initial_credit_paise && initial_credit_paise > 0 ? initial_credit_paise : 0;
    const accountInsertQuery = `
      INSERT INTO accounts (owner_name, currency, merchant_id, balance_paise)
      VALUES ($1, $2, $3, $4)
      RETURNING id, owner_name, currency, merchant_id, balance_paise, created_at;
    `;
    const accountResult = await client.query(accountInsertQuery, [
      owner_name,
      currency || 'INR',
      merchantId,
      initialPaise,
    ]);
    const account = accountResult.rows[0];

    let initialTransactionId: string | null = null;
    let initialLedgerEntry: any = null;

    // 2. If seed credit provided, insert initial CREDIT ledger entry
    if (initial_credit_paise && initial_credit_paise > 0) {
      initialTransactionId = uuidv4();
      const ledgerInsertQuery = `
        INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
        VALUES ($1, $2, 'CREDIT', $3)
        RETURNING id, transaction_id, entry_type, amount, created_at;
      `;
      const ledgerResult = await client.query(ledgerInsertQuery, [
        initialTransactionId,
        account.id,
        initial_credit_paise,
      ]);
      initialLedgerEntry = ledgerResult.rows[0];
    }

    await client.query('COMMIT');

    res.status(201).json({
      id: account.id,
      merchant_id: account.merchant_id,
      owner_name: account.owner_name,
      currency: account.currency,
      balance_paise: initial_credit_paise || 0,
      initial_transaction_id: initialTransactionId,
      created_at: account.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

export async function listAccounts(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const merchantId = getEffectiveMerchantId(req, res);
    if (!merchantId) return;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    const listQuery = `
      SELECT 
        id,
        merchant_id,
        owner_name,
        currency,
        balance_paise,
        created_at
      FROM accounts
      WHERE merchant_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3;
    `;

    const countQuery = `SELECT COUNT(*)::INT AS total FROM accounts WHERE merchant_id = $1;`;

    const [accountsResult, countResult] = await Promise.all([
      query(listQuery, [merchantId, limit, offset]),
      query(countQuery, [merchantId]),
    ]);

    const accounts = accountsResult.rows.map((row) => ({
      ...row,
      balance_paise: Number(row.balance_paise),
    }));

    res.status(200).json({
      data: accounts,
      pagination: {
        total: countResult.rows[0].total,
        limit,
        offset,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function getAccountById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const merchantId = getEffectiveMerchantId(req, res);
    if (!merchantId) return;

    const accountQuery = `
      SELECT 
        id,
        merchant_id,
        owner_name,
        currency,
        balance_paise,
        created_at
      FROM accounts
      WHERE id = $1 AND merchant_id = $2;
    `;

    const accountResult = await query(accountQuery, [id, merchantId]);

    // Return 404 for non-existent OR foreign merchant accounts
    if (accountResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Account with ID '${id}' not found`,
      });
      return;
    }

    const recentEntriesQuery = `
      SELECT id, transaction_id, entry_type, amount, created_at
      FROM ledger_entries
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT 10;
    `;

    const entriesResult = await query(recentEntriesQuery, [id]);

    const account = accountResult.rows[0];

    res.status(200).json({
      id: account.id,
      merchant_id: account.merchant_id,
      owner_name: account.owner_name,
      currency: account.currency,
      balance_paise: Number(account.balance_paise),
      created_at: account.created_at,
      recent_ledger_entries: entriesResult.rows.map((e) => ({
        ...e,
        amount: Number(e.amount),
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function getAccountLedger(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const merchantId = getEffectiveMerchantId(req, res);
    if (!merchantId) return;

    const accountQuery = `
      SELECT id, merchant_id, owner_name, currency, balance_paise, created_at 
      FROM accounts 
      WHERE id = $1 AND merchant_id = $2;
    `;
    const accountResult = await query(accountQuery, [id, merchantId]);

    // Return 404 for non-existent OR foreign merchant accounts
    if (accountResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Account with ID '${id}' not found`,
      });
      return;
    }

    const entriesQuery = `
      SELECT id, transaction_id, account_id, entry_type, amount, created_at
      FROM ledger_entries
      WHERE account_id = $1
      ORDER BY created_at ASC, id ASC;
    `;
    const entriesResult = await query(entriesQuery, [id]);

    const account = accountResult.rows[0];

    let balancePaise =
      account.balance_paise !== null && account.balance_paise !== undefined
        ? Number(account.balance_paise)
        : null;

    if (balancePaise === null || isNaN(balancePaise)) {
      const computedBigInt = entriesResult.rows.reduce((sum: bigint, e: any) => {
        const amt = BigInt(e.amount);
        return e.entry_type === 'CREDIT' ? sum + amt : sum - amt;
      }, 0n);
      balancePaise = Number(computedBigInt);
    }

    res.status(200).json({
      account_id: account.id,
      merchant_id: account.merchant_id,
      owner_name: account.owner_name,
      currency: account.currency,
      balance_paise: balancePaise,
      created_at: account.created_at,
      ledger_entries: entriesResult.rows.map((entry) => ({
        id: entry.id,
        transaction_id: entry.transaction_id,
        account_id: entry.account_id,
        entry_type: entry.entry_type,
        amount: Number(entry.amount),
        created_at: entry.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}
