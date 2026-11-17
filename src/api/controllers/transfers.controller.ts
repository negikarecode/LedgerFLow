import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../db/pool';
import { redis } from '../../redis/client';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

export async function createTransfer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { from_account_id, to_account_id, amount_paise } = req.body;
  const idempotency = req.idempotency;
  const merchantId = req.merchant?.id || idempotency?.merchantId || DEFAULT_DEMO_MERCHANT_ID;

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Deadlock-free locking: Sort IDs alphabetically before SELECT FOR UPDATE
    // CRITICAL: Both accounts must belong to the authenticated merchant.
    // If one or both are missing or belong to another merchant, return 404 (never 403).
    const [firstId, secondId] = [from_account_id, to_account_id].sort();
    const lockQuery = `
      SELECT id, merchant_id 
      FROM accounts 
      WHERE id IN ($1, $2) AND merchant_id = $3
      ORDER BY id FOR UPDATE;
    `;
    const lockResult = await client.query(lockQuery, [firstId, secondId, merchantId]);

    if (lockResult.rows.length < 2) {
      await client.query('ROLLBACK');
      res.status(404).json({
        error: 'Not Found',
        message: 'One or both accounts not found',
      });
      return;
    }

    // 2. Calculate from_account_id balance from ledger_entries
    const balanceQuery = `
      SELECT COALESCE(SUM(
        CASE 
          WHEN entry_type = 'CREDIT' THEN amount
          WHEN entry_type = 'DEBIT' THEN -amount
          ELSE 0
        END
      ), 0)::BIGINT AS balance_paise
      FROM ledger_entries
      WHERE account_id = $1;
    `;
    const balanceResult = await client.query(balanceQuery, [from_account_id]);
    const currentBalance = Number(balanceResult.rows[0].balance_paise);

    if (currentBalance < amount_paise) {
      await client.query('ROLLBACK');
      res.status(422).json({
        error: 'Unprocessable Entity',
        message: 'Insufficient funds',
      });
      return;
    }

    // 3. Insert 2 rows into ledger_entries (DEBIT and CREDIT)
    const transactionId = uuidv4();
    const ledgerInsertQuery = `
      INSERT INTO ledger_entries (transaction_id, account_id, entry_type, amount)
      VALUES 
        ($1, $2, 'DEBIT', $4),
        ($1, $3, 'CREDIT', $4)
      RETURNING id, transaction_id, account_id, entry_type, amount, created_at;
    `;
    const ledgerResult = await client.query(ledgerInsertQuery, [
      transactionId,
      from_account_id,
      to_account_id,
      amount_paise,
    ]);

    const createdAt = ledgerResult.rows[0].created_at;

    // 4. Create one outbox_events row per ACTIVE endpoint of that merchant subscribed to 'transfer.completed'
    // inside the same transaction as the ledger entries.
    const endpointQuery = `
      SELECT id, url, secret
      FROM webhook_endpoints
      WHERE merchant_id = $1
        AND status = 'ACTIVE'
        AND 'transfer.completed' = ANY(event_types);
    `;
    const endpointResult = await client.query(endpointQuery, [merchantId]);

    const outboxPayload = {
      event: 'transfer.completed',
      transaction_id: transactionId,
      from_account_id,
      to_account_id,
      amount_paise,
      created_at: createdAt,
    };

    const outboxEventIds: string[] = [];

    for (const ep of endpointResult.rows) {
      const outboxInsertQuery = `
        INSERT INTO outbox_events (event_type, payload, target_url, status, merchant_id, endpoint_id)
        VALUES ($1, $2, $3, 'PENDING', $4, $5)
        RETURNING id;
      `;
      const outboxResult = await client.query(outboxInsertQuery, [
        'transfer.completed',
        JSON.stringify(outboxPayload),
        ep.url,
        merchantId,
        ep.id,
      ]);
      outboxEventIds.push(outboxResult.rows[0].id);
    }

    // 5. Build response body
    const responseBody = {
      transaction_id: transactionId,
      from_account_id,
      to_account_id,
      amount_paise,
      status: 'COMPLETED',
      outbox_event_id: outboxEventIds[0] || null,
      outbox_event_ids: outboxEventIds,
      created_at: createdAt,
    };

    // 6. Save the 201 response in idempotency_keys inside the SAME transaction namespaced by merchant_id
    if (idempotency) {
      const idempotencyInsertQuery = `
        INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body)
        VALUES ($1, $2, $3, 201, $4)
        ON CONFLICT (merchant_id, key) DO UPDATE SET
          request_hash = EXCLUDED.request_hash,
          response_status = EXCLUDED.response_status,
          response_body = EXCLUDED.response_body;
      `;
      await client.query(idempotencyInsertQuery, [
        idempotency.key,
        merchantId,
        idempotency.requestHash,
        JSON.stringify(responseBody),
      ]);
    }

    // 7. COMMIT PostgreSQL transaction
    await client.query('COMMIT');

    // 8. Cache response in Redis (24h TTL)
    if (idempotency) {
      await redis.set(
        idempotency.redisKey,
        JSON.stringify({
          request_hash: idempotency.requestHash,
          response_status: 201,
          response_body: responseBody,
        }),
        'EX',
        86400
      );
    }

    res.status(201).json(responseBody);
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
