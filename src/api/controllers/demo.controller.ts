import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../db/pool';
import { redis } from '../../redis/client';
import { clearReceivedEvents } from './merchant.controller';

/**
 * Reset Demo State:
 * 1. Truncates all transactional and ledger tables (accounts, ledger_entries, idempotency_keys, outbox_events)
 * 2. Clears Redis idempotency caches and mock merchant crash/event state
 * 3. Seeds 2 clean test wallets:
 *    - Alice Sharma: 100,000 paise (₹1,000.00)
 *    - Bob Patel: 50,000 paise (₹500.00)
 */
export async function resetDemoState(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Truncate all tables
    await client.query(`
      TRUNCATE TABLE outbox_events, idempotency_keys, ledger_entries, accounts CASCADE;
    `);

    // 2. Seed Alice Sharma
    const aliceId = uuidv4();
    const aliceTxId = uuidv4();
    await client.query(
      `INSERT INTO accounts (id, owner_name, currency) VALUES ($1, $2, $3);`,
      [aliceId, 'Alice Sharma', 'INR']
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'CREDIT', $3);`,
      [aliceTxId, aliceId, 100000]
    );

    // 3. Seed Bob Patel
    const bobId = uuidv4();
    const bobTxId = uuidv4();
    await client.query(
      `INSERT INTO accounts (id, owner_name, currency) VALUES ($1, $2, $3);`,
      [bobId, 'Bob Patel', 'INR']
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'CREDIT', $3);`,
      [bobTxId, bobId, 50000]
    );

    await client.query('COMMIT');

    // 4. Clear Redis cache and state
    try {
      const idempKeys = await redis.keys('idemp:*');
      if (idempKeys.length > 0) {
        await redis.del(...idempKeys);
      }
      await redis.del('mock_merchant:events');
      await redis.set('mock_merchant:crash_mode', 'false');
    } catch (redisErr) {
      console.warn('[Demo Reset] Redis cleanup warning:', redisErr);
    }

    // 5. Clear in-memory mock merchant events and crash mode
    await clearReceivedEvents();

    const seededAccounts = [
      {
        id: aliceId,
        owner_name: 'Alice Sharma',
        currency: 'INR',
        balance_paise: 100000,
        initial_transaction_id: aliceTxId,
      },
      {
        id: bobId,
        owner_name: 'Bob Patel',
        currency: 'INR',
        balance_paise: 50000,
        initial_transaction_id: bobTxId,
      },
    ];

    res.status(200).json({
      message: 'Demo state reset successfully: tables truncated and Alice Sharma & Bob Patel wallets seeded',
      accounts: seededAccounts,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failure if connection was lost
    }
    next(err);
  } finally {
    client.release();
  }
}
