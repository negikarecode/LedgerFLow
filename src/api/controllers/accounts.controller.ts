import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient, query } from '../../db/pool';

export async function createAccount(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { owner_name, currency, initial_credit_paise } = req.body;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Insert Account
    const accountInsertQuery = `
      INSERT INTO accounts (owner_name, currency)
      VALUES ($1, $2)
      RETURNING id, owner_name, currency, created_at;
    `;
    const accountResult = await client.query(accountInsertQuery, [
      owner_name,
      currency || 'INR',
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
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    const listQuery = `
      SELECT 
        a.id,
        a.owner_name,
        a.currency,
        a.created_at,
        COALESCE(SUM(
          CASE 
            WHEN le.entry_type = 'CREDIT' THEN le.amount
            WHEN le.entry_type = 'DEBIT' THEN -le.amount
            ELSE 0
          END
        ), 0)::BIGINT AS balance_paise
      FROM accounts a
      LEFT JOIN ledger_entries le ON a.id = le.account_id
      GROUP BY a.id, a.owner_name, a.currency, a.created_at
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2;
    `;

    const countQuery = `SELECT COUNT(*)::INT AS total FROM accounts;`;

    const [accountsResult, countResult] = await Promise.all([
      query(listQuery, [limit, offset]),
      query(countQuery),
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

    const accountQuery = `
      SELECT 
        a.id,
        a.owner_name,
        a.currency,
        a.created_at,
        COALESCE(SUM(
          CASE 
            WHEN le.entry_type = 'CREDIT' THEN le.amount
            WHEN le.entry_type = 'DEBIT' THEN -le.amount
            ELSE 0
          END
        ), 0)::BIGINT AS balance_paise
      FROM accounts a
      LEFT JOIN ledger_entries le ON a.id = le.account_id
      WHERE a.id = $1
      GROUP BY a.id, a.owner_name, a.currency, a.created_at;
    `;

    const accountResult = await query(accountQuery, [id]);

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
