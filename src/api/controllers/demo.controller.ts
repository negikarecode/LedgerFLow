import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../db/pool';
import { redis } from '../../redis/client';
import { clearReceivedEvents } from './merchant.controller';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_DEMO_KEY_ID = '00000000-0000-0000-0000-000000000002';
const DEFAULT_DEMO_KEY_HASH = 'c493db595f469fe025715057076dd17b8c4c8b80f596988553641df7d04a33be';

/**
 * Reset Demo State:
 * 1. Truncates all transactional and ledger tables (accounts, ledger_entries, idempotency_keys, outbox_events)
 * 2. Ensures Default Demo Merchant and fixed Demo API Key exist
 * 3. Clears Redis idempotency caches and mock merchant crash/event state
 * 4. Seeds 2 clean test wallets for Default Demo Merchant:
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

    // 1. Truncate transaction tables
    await client.query(`
      TRUNCATE TABLE outbox_events, idempotency_keys, ledger_entries, accounts CASCADE;
    `);

    // 2. Ensure default demo merchant and api key exist
    await client.query(`
      INSERT INTO merchants (id, name)
      VALUES ($1, 'Default Demo Merchant')
      ON CONFLICT (id) DO NOTHING;
    `, [DEFAULT_DEMO_MERCHANT_ID]);

    await client.query(`
      INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash)
      VALUES ($1, $2, 'lf_live_demo_key', $3)
      ON CONFLICT (id) DO NOTHING;
    `, [DEFAULT_DEMO_KEY_ID, DEFAULT_DEMO_MERCHANT_ID, DEFAULT_DEMO_KEY_HASH]);

    // Ensure default demo webhook endpoint exists and is ACTIVE
    await client.query(`
      INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
      VALUES (
        '00000000-0000-0000-0000-000000000002',
        $1,
        'http://127.0.0.1:3000/mock-merchant/webhook',
        'default-ledgerflow-secret-key-12345',
        ARRAY['transfer.completed']::TEXT[],
        'ACTIVE'
      )
      ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE';
    `, [DEFAULT_DEMO_MERCHANT_ID]);

    // 3. Seed Alice Sharma
    const aliceId = uuidv4();
    const aliceTxId = uuidv4();
    await client.query(
      `INSERT INTO accounts (id, owner_name, currency, merchant_id) VALUES ($1, $2, $3, $4);`,
      [aliceId, 'Alice Sharma', 'INR', DEFAULT_DEMO_MERCHANT_ID]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'CREDIT', $3);`,
      [aliceTxId, aliceId, 100000]
    );

    // 4. Seed Bob Patel
    const bobId = uuidv4();
    const bobTxId = uuidv4();
    await client.query(
      `INSERT INTO accounts (id, owner_name, currency, merchant_id) VALUES ($1, $2, $3, $4);`,
      [bobId, 'Bob Patel', 'INR', DEFAULT_DEMO_MERCHANT_ID]
    );
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
       VALUES ($1, $2, 'CREDIT', $3);`,
      [bobTxId, bobId, 50000]
    );

    await client.query('COMMIT');

    // 5. Clear Redis cache and state
    try {
      const keysToDel: string[] = [];
      const idempKeys = await redis.keys('idemp:*');
      if (idempKeys.length > 0) keysToDel.push(...idempKeys);

      const cbKeys = await redis.keys('cb:*');
      if (cbKeys.length > 0) keysToDel.push(...cbKeys);

      const rlKeys = await redis.keys('ratelimit:*');
      if (rlKeys.length > 0) keysToDel.push(...rlKeys);

      const concKeys = await redis.keys('concurrency:*');
      if (concKeys.length > 0) keysToDel.push(...concKeys);

      if (keysToDel.length > 0) {
        await redis.del(...keysToDel);
      }
      await redis.del('mock_merchant:events');
      await redis.set('mock_merchant:crash_mode', 'false');
    } catch (redisErr) {
      console.warn('[Demo Reset] Redis cleanup warning:', redisErr);
    }

    // 6. Clear in-memory mock merchant events and crash mode
    await clearReceivedEvents();

    const seededAccounts = [
      {
        id: aliceId,
        owner_name: 'Alice Sharma',
        currency: 'INR',
        balance_paise: 100000,
        merchant_id: DEFAULT_DEMO_MERCHANT_ID,
        initial_transaction_id: aliceTxId,
      },
      {
        id: bobId,
        owner_name: 'Bob Patel',
        currency: 'INR',
        balance_paise: 50000,
        merchant_id: DEFAULT_DEMO_MERCHANT_ID,
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
