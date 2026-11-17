import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../db/pool';
import { redis } from '../../redis/client';

export async function createTransfer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { from_account_id, to_account_id, amount_paise, webhook_url } = req.body;
  const idempotency = req.idempotency;

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 1. Deadlock-free locking: Sort IDs alphabetically before SELECT FOR UPDATE
    const [firstId, secondId] = [from_account_id, to_account_id].sort();
    const lockQuery = `
      SELECT id 
      FROM accounts 
      WHERE id IN ($1, $2) 
      ORDER BY id FOR UPDATE;
    `;
    const lockResult = await client.query(lockQuery, [firstId, secondId]);

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

    // 4. If webhook_url is provided, insert PENDING event into outbox_events
    let outboxEventId: string | null = null;
    if (webhook_url) {
      const outboxPayload = {
        event: 'transfer.completed',
        transaction_id: transactionId,
        from_account_id,
        to_account_id,
        amount_paise,
        created_at: createdAt,
      };

      const outboxInsertQuery = `
        INSERT INTO outbox_events (event_type, payload, target_url, status)
        VALUES ($1, $2, $3, 'PENDING')
        RETURNING id;
      `;
      const outboxResult = await client.query(outboxInsertQuery, [
        'transfer.completed',
        JSON.stringify(outboxPayload),
        webhook_url,
      ]);
      outboxEventId = outboxResult.rows[0].id;
    }

    // 5. Build response body
    const responseBody = {
      transaction_id: transactionId,
      from_account_id,
      to_account_id,
      amount_paise,
      status: 'COMPLETED',
      webhook_url: webhook_url || null,
      outbox_event_id: outboxEventId,
      created_at: createdAt,
    };

    // 6. Save the 201 response in idempotency_keys inside the SAME transaction
    if (idempotency) {
      const idempotencyInsertQuery = `
        INSERT INTO idempotency_keys (key, request_hash, response_status, response_body)
        VALUES ($1, $2, 201, $3)
        ON CONFLICT (key) DO UPDATE SET
          request_hash = EXCLUDED.request_hash,
          response_status = EXCLUDED.response_status,
          response_body = EXCLUDED.response_body;
      `;
      await client.query(idempotencyInsertQuery, [
        idempotency.key,
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
