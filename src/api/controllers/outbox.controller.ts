import { Request, Response, NextFunction } from 'express';
import { query } from '../../db/pool';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

export async function listOutboxEvents(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const status = req.query.status as string | undefined;

    let sql = `
      SELECT id, merchant_id, event_type, payload, target_url, status, attempts, next_retry_at, created_at
      FROM outbox_events
      WHERE merchant_id = $1
    `;
    let countSql = `SELECT COUNT(*)::INT AS total FROM outbox_events WHERE merchant_id = $1`;
    const params: any[] = [merchantId];

    if (status) {
      sql += ` AND status = $2`;
      countSql += ` AND status = $2`;
      params.push(status);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;

    const [eventsResult, countResult] = await Promise.all([
      query(sql, [...params, limit, offset]),
      query(countSql, status ? [merchantId, status] : [merchantId]),
    ]);

    res.status(200).json({
      data: eventsResult.rows.map((row) => ({
        id: row.id,
        merchant_id: row.merchant_id,
        event_type: row.event_type,
        payload: row.payload,
        target_url: row.target_url,
        status: row.status,
        attempts: Number(row.attempts),
        next_retry_at: row.next_retry_at,
        created_at: row.created_at,
      })),
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

export async function replayOutboxEvent(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

    // Check ownership by merchant (returns 404 for non-existent or foreign events)
    const checkResult = await query(
      `SELECT id, status FROM outbox_events WHERE id = $1 AND merchant_id = $2`,
      [id, merchantId]
    );

    if (checkResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Outbox event with ID '${id}' not found`,
      });
      return;
    }

    const updateResult = await query(
      `UPDATE outbox_events 
       SET status = 'PENDING', attempts = 0, next_retry_at = NOW() 
       WHERE id = $1 AND merchant_id = $2
       RETURNING id, merchant_id, event_type, payload, target_url, status, attempts, next_retry_at, created_at`,
      [id, merchantId]
    );

    const updated = updateResult.rows[0];

    res.status(200).json({
      message: 'Outbox event reset to PENDING for immediate redelivery',
      event: {
        id: updated.id,
        merchant_id: updated.merchant_id,
        event_type: updated.event_type,
        payload: updated.payload,
        target_url: updated.target_url,
        status: updated.status,
        attempts: Number(updated.attempts),
        next_retry_at: updated.next_retry_at,
        created_at: updated.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
}
