import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient } from '../../db/pool';
import { redis } from '../../redis/client';
import { env } from '../../config/env';
import { transfersTotal, idempotencyReplaysTotal } from '../../observability/metrics';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

export async function createTransfer(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { from_account_id, to_account_id, amount_paise } = req.body;
  const idempotency = req.idempotency;
  const isProduction = env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';
  const merchantId = req.merchant?.id || idempotency?.merchantId || (!isProduction ? DEFAULT_DEMO_MERCHANT_ID : null);
  if (!merchantId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Merchant authentication required',
    });
    return;
  }

  // 0a. Pre-flight check: Reject same-account transfers before database acquisition or locks
  const rawFrom = from_account_id || req.body?.source_account_id;
  const rawTo = to_account_id || req.body?.destination_account_id;
  const fromNormalized = typeof rawFrom === 'string' ? rawFrom.trim().toLowerCase() : '';
  const toNormalized = typeof rawTo === 'string' ? rawTo.trim().toLowerCase() : '';

  if (fromNormalized && toNormalized && fromNormalized === toNormalized) {
    transfersTotal.inc({ outcome: 'same_account_rejected' });
    res.status(400).json({
      error: 'Validation failed',
      details: [
        {
          field: 'to_account_id',
          message: 'from_account_id and to_account_id must not be the same',
        },
      ],
    });
    return;
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // 0b. Authoritative in-transaction check: Guarantee zero mutations for same-account transfers
    if (fromNormalized === toNormalized) {
      await client.query('ROLLBACK');
      transfersTotal.inc({ outcome: 'same_account_rejected' });
      res.status(400).json({
        error: 'Validation failed',
        details: [
          {
            field: 'to_account_id',
            message: 'from_account_id and to_account_id must not be the same',
          },
        ],
      });
      return;
    }

    // 0. PostgreSQL Idempotency Lock & Durable Concurrency Guard (Source of Truth)
    // Ensures absolute correctness even if the Redis lock expired mid-flight or Redis is down.
    if (idempotency) {
      const idempLockQuery = `
        INSERT INTO idempotency_keys (key, merchant_id, request_hash, response_status, response_body, locked_at)
        VALUES ($1, $2, $3, NULL, NULL, NOW())
        ON CONFLICT (merchant_id, key) DO UPDATE
          SET locked_at = idempotency_keys.locked_at
        RETURNING key, request_hash, response_status, response_body;
      `;
      const idempResult = await client.query(idempLockQuery, [
        idempotency.key,
        merchantId,
        idempotency.requestHash,
      ]);

      const stored = idempResult.rows[0];

      if (stored) {
        // If request_hash differs, this is a key reuse mismatch
        if (stored.request_hash !== idempotency.requestHash) {
          await client.query('ROLLBACK');

          if (idempotency.redisAvailable && stored.response_status !== null) {
            try {
              await redis.set(
                idempotency.redisKey,
                JSON.stringify({
                  request_hash: stored.request_hash,
                  response_status: stored.response_status,
                  response_body: stored.response_body,
                }),
                'EX',
                env.IDEMPOTENCY_RETENTION_SECONDS
              );
            } catch {}
          }

          transfersTotal.inc({ outcome: 'key_reuse_mismatch' });
          res.status(422).json({
            error: 'Unprocessable Entity',
            code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
            message:
              'Idempotency key has already been used with a different request payload or endpoint',
          });
          return;
        }

        // If already completed in a prior transaction or a concurrent transaction that just committed
        if (stored.response_status !== null) {
          await client.query('ROLLBACK');

          // Cache completed in Redis if Redis is available
          try {
            await redis.set(
              idempotency.redisKey,
              JSON.stringify({
                request_hash: stored.request_hash,
                response_status: stored.response_status,
                response_body: stored.response_body,
              }),
              'EX',
              env.IDEMPOTENCY_RETENTION_SECONDS
            );
          } catch {
            // Redis failure is non-fatal
          }

          transfersTotal.inc({ outcome: 'replay' });
          idempotencyReplaysTotal.inc();
          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(stored.response_status).json(stored.response_body);
          return;
        }
      }
    }

    // 1. Deadlock-free locking: Sort IDs alphabetically before SELECT FOR UPDATE
    // CRITICAL: Both accounts must belong to the authenticated merchant.
    // If one or both are missing or belong to another merchant, return 404 (never 403).
    const [firstId, secondId] = [
      fromNormalized || from_account_id,
      toNormalized || to_account_id,
    ].sort();
    const lockQuery = `
      SELECT id, merchant_id, balance_paise 
      FROM accounts 
      WHERE id IN ($1, $2) AND merchant_id = $3
      ORDER BY id FOR UPDATE;
    `;
    const lockResult = await client.query(lockQuery, [firstId, secondId, merchantId]);

    if (lockResult.rows.length < 2) {
      await client.query('ROLLBACK');
      transfersTotal.inc({ outcome: 'not_found' });
      res.status(404).json({
        error: 'Not Found',
        message: 'One or both accounts not found',
      });
      return;
    }

    const fromAccount = lockResult.rows.find(
      (r) => r.id === from_account_id || r.id === fromNormalized
    );
    const toAccount = lockResult.rows.find(
      (r) => r.id === to_account_id || r.id === toNormalized
    );

    // 2. Exact BigInt balance and overflow verification
    const fromBalance = BigInt(fromAccount.balance_paise);
    const toBalance = BigInt(toAccount.balance_paise);
    const transferAmount = BigInt(amount_paise);

    if (fromBalance < transferAmount) {
      await client.query('ROLLBACK');
      transfersTotal.inc({ outcome: 'insufficient_funds' });
      res.status(422).json({
        error: 'Unprocessable Entity',
        message: 'Insufficient funds',
      });
      return;
    }

    const MAX_SAFE_PAISE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

    // Guard against recipient balance overflow beyond Number.MAX_SAFE_INTEGER
    if (toBalance + transferAmount > MAX_SAFE_PAISE_BIGINT) {
      await client.query('ROLLBACK');
      transfersTotal.inc({ outcome: 'balance_overflow' });
      res.status(422).json({
        error: 'Unprocessable Entity',
        message: 'Transfer would exceed maximum supported account balance',
      });
      return;
    }

    // 3. Atomically update cached balance columns under existing row lock
    const updateBalancesQuery = `
      UPDATE accounts
      SET balance_paise = CASE 
        WHEN id = $1 THEN balance_paise - $3
        WHEN id = $2 THEN balance_paise + $3
      END
      WHERE id IN ($1, $2);
    `;
    await client.query(updateBalancesQuery, [
      from_account_id,
      to_account_id,
      amount_paise,
    ]);

    // 4. Insert 2 rows into immutable ledger_entries (DEBIT and CREDIT)
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

    // Verify double-entry accounting invariants: exactly 2 entries (DEBIT and CREDIT) balancing to zero
    if (ledgerResult.rows.length !== 2) {
      throw new Error(
        `Double-entry invariant violation: expected 2 ledger entries, got ${ledgerResult.rows.length}`
      );
    }
    const debitEntry = ledgerResult.rows.find((r) => r.entry_type === 'DEBIT');
    const creditEntry = ledgerResult.rows.find((r) => r.entry_type === 'CREDIT');
    if (!debitEntry || !creditEntry) {
      throw new Error('Double-entry invariant violation: missing DEBIT or CREDIT entry');
    }
    const debitAmount = BigInt(debitEntry.amount);
    const creditAmount = BigInt(creditEntry.amount);
    if (
      debitAmount !== transferAmount ||
      creditAmount !== transferAmount ||
      creditAmount - debitAmount !== 0n
    ) {
      throw new Error(
        'Double-entry invariant violation: DEBIT and CREDIT entries do not balance to zero'
      );
    }

    const createdAt = ledgerResult.rows[0].created_at;
    const requestId = (req as any).id || (req.headers['x-request-id'] as string) || null;

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

    const outboxEventIds: string[] = [];

    for (const ep of endpointResult.rows) {
      const eventId = uuidv4();
      const outboxPayload = {
        event_id: eventId,
        event: 'transfer.completed',
        transaction_id: transactionId,
        from_account_id,
        to_account_id,
        amount_paise,
        request_id: requestId,
        created_at: createdAt,
      };

      const outboxInsertQuery = `
        INSERT INTO outbox_events (id, event_type, payload, target_url, status, merchant_id, endpoint_id, request_id)
        VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7)
        RETURNING id;
      `;
      const outboxResult = await client.query(outboxInsertQuery, [
        eventId,
        'transfer.completed',
        JSON.stringify(outboxPayload),
        ep.url,
        merchantId,
        ep.id,
        requestId,
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

    // 6. Save the 201 response in idempotency_keys inside the SAME transaction
    if (idempotency) {
      const idempotencyUpdateQuery = `
        UPDATE idempotency_keys
        SET response_status = 201,
            response_body = $1,
            locked_at = NULL
        WHERE merchant_id = $2 AND key = $3;
      `;
      await client.query(idempotencyUpdateQuery, [
        JSON.stringify(responseBody),
        merchantId,
        idempotency.key,
      ]);
    }

    // 7. COMMIT PostgreSQL transaction
    await client.query('COMMIT');

    // 8. Cache response in Redis (configurable retention, default 24h)
    if (idempotency) {
      try {
        await redis.set(
          idempotency.redisKey,
          JSON.stringify({
            request_hash: idempotency.requestHash,
            response_status: 201,
            response_body: responseBody,
          }),
          'EX',
          env.IDEMPOTENCY_RETENTION_SECONDS
        );
      } catch (redisErr) {
        // Non-fatal if Redis is down
        console.warn('[Transfers] Failed to cache response in Redis:', (redisErr as any)?.message);
      }
    }

    transfersTotal.inc({ outcome: 'created' });
    if ((req as any).log) {
      (req as any).log.info(
        {
          transaction_id: transactionId,
          from_account_id,
          to_account_id,
          amount_paise,
          outbox_events_count: outboxEventIds.length,
          request_id: requestId,
        },
        'Transfer successfully created'
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
