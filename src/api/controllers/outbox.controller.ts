import { Request, Response, NextFunction } from 'express';
import { query } from '../../db/pool';
import { getWebhookQueue } from '../../worker';
import { env } from '../../config/env';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

interface CursorData {
  created_at: string;
  id: string;
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

function decodeCursor(cursorStr: string): CursorData | null {
  try {
    const raw = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.created_at && parsed.id) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /outbox
 * Lists outbox events for the authenticated merchant with filtering and cursor pagination.
 */
export async function listOutboxEvents(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const status = req.query.status as string | undefined;
    const endpointId = req.query.endpoint_id as string | undefined;
    const startDate = req.query.start_date as string | undefined;
    const endDate = req.query.end_date as string | undefined;
    const cursorParam = req.query.cursor as string | undefined;
    const offsetParam = req.query.offset ? Number(req.query.offset) : undefined;

    const conditions: string[] = ['merchant_id = $1'];
    const params: any[] = [merchantId];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (endpointId) {
      params.push(endpointId);
      conditions.push(`endpoint_id = $${params.length}`);
    }

    if (startDate) {
      params.push(new Date(startDate).toISOString());
      conditions.push(`created_at >= $${params.length}`);
    }

    if (endDate) {
      params.push(new Date(endDate).toISOString());
      conditions.push(`created_at <= $${params.length}`);
    }

    const whereClause = conditions.join(' AND ');

    // Total count for metadata
    const countResult = await query(
      `SELECT COUNT(*)::INT AS total FROM outbox_events WHERE ${whereClause}`,
      params
    );
    const totalCount = countResult.rows[0].total;

    let sql = `
      SELECT id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts, next_retry_at, created_at
      FROM outbox_events
      WHERE ${whereClause}
    `;

    // Handle cursor vs offset pagination
    const queryParams = [...params];

    if (cursorParam) {
      const decoded = decodeCursor(cursorParam);
      if (decoded) {
        queryParams.push(decoded.created_at, decoded.id);
        sql += ` AND (created_at, id) < ($${queryParams.length - 1}, $${queryParams.length})`;
      }
    }

    sql += ` ORDER BY created_at DESC, id DESC`;

    // Fetch limit + 1 to detect hasNextPage for cursor
    queryParams.push(limit + 1);
    sql += ` LIMIT $${queryParams.length}`;

    if (!cursorParam && offsetParam !== undefined && offsetParam > 0) {
      queryParams.push(offsetParam);
      sql += ` OFFSET $${queryParams.length}`;
    }

    const eventsResult = await query(sql, queryParams);
    const rows = eventsResult.rows;

    let nextCursor: string | null = null;
    let returnRows = rows;

    if (rows.length > limit) {
      returnRows = rows.slice(0, limit);
      const lastRow = returnRows[returnRows.length - 1];
      nextCursor = encodeCursor({
        created_at: lastRow.created_at.toISOString ? lastRow.created_at.toISOString() : lastRow.created_at,
        id: lastRow.id,
      });
    }

    res.status(200).json({
      data: returnRows.map((row) => ({
        id: row.id,
        merchant_id: row.merchant_id,
        endpoint_id: row.endpoint_id,
        event_type: row.event_type,
        payload: row.payload,
        target_url: row.target_url,
        status: row.status,
        attempts: Number(row.attempts),
        next_retry_at: row.next_retry_at,
        created_at: row.created_at,
      })),
      pagination: {
        total: totalCount,
        limit,
        offset: offsetParam ?? 0,
        next_cursor: nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /outbox/:id
 * Returns single outbox event with full delivery_attempts history.
 */
export async function getOutboxEvent(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

    const eventResult = await query(
      `SELECT id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts, next_retry_at, created_at
       FROM outbox_events
       WHERE id = $1 AND merchant_id = $2`,
      [id, merchantId]
    );

    if (eventResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Outbox event with ID '${id}' not found`,
      });
      return;
    }

    const event = eventResult.rows[0];

    const attemptsResult = await query(
      `SELECT id, outbox_event_id, attempt_number, started_at, duration_ms,
              http_status, error_message, request_signature, next_retry_at, created_at
       FROM delivery_attempts
       WHERE outbox_event_id = $1
       ORDER BY attempt_number ASC, started_at ASC`,
      [id]
    );

    res.status(200).json({
      id: event.id,
      merchant_id: event.merchant_id,
      endpoint_id: event.endpoint_id,
      event_type: event.event_type,
      payload: event.payload,
      target_url: event.target_url,
      status: event.status,
      attempts: Number(event.attempts),
      next_retry_at: event.next_retry_at,
      created_at: event.created_at,
      delivery_attempts: attemptsResult.rows.map((att) => ({
        id: att.id,
        outbox_event_id: att.outbox_event_id,
        attempt_number: Number(att.attempt_number),
        started_at: att.started_at,
        duration_ms: Number(att.duration_ms),
        http_status: att.http_status !== null ? Number(att.http_status) : null,
        error_message: att.error_message,
        request_signature: att.request_signature,
        next_retry_at: att.next_retry_at,
        created_at: att.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /outbox/:id/replay
 * Replays a DEAD_LETTER or DELIVERED outbox event.
 * Resets attempt count to 0, sets status to PENDING, preserves full attempt history,
 * and reuses the stable event_id in the payload for receiver deduplication.
 */
export async function replayOutboxEvent(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

    // Check ownership and current status
    const checkResult = await query(
      `SELECT o.id, o.status, o.event_type, o.payload, o.target_url, o.endpoint_id,
              e.secret as endpoint_secret
       FROM outbox_events o
       LEFT JOIN webhook_endpoints e ON e.id = o.endpoint_id
       WHERE o.id = $1 AND o.merchant_id = $2`,
      [id, merchantId]
    );

    if (checkResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Outbox event with ID '${id}' not found`,
      });
      return;
    }

    const event = checkResult.rows[0];

    // Only allow replay for DEAD_LETTER or DELIVERED events
    if (event.status === 'PENDING') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot replay an event that is currently PENDING delivery',
      });
      return;
    }

    // Reset status to PENDING, attempts to 0, next_retry_at to NOW()
    const updateResult = await query(
      `UPDATE outbox_events 
       SET status = 'PENDING', attempts = 0, next_retry_at = NOW() 
       WHERE id = $1 AND merchant_id = $2
       RETURNING id, merchant_id, endpoint_id, event_type, payload, target_url, status, attempts, next_retry_at, created_at`,
      [id, merchantId]
    );

    const updated = updateResult.rows[0];

    // Immediately enqueue into BullMQ for delivery
    try {
      const queue = getWebhookQueue();
      await queue.add(
        'send-webhook',
        {
          eventId: updated.id,
          eventType: updated.event_type,
          targetUrl: updated.target_url,
          payload: updated.payload,
          attempts: 0,
          secret: event.endpoint_secret || env.WEBHOOK_SECRET,
          endpointId: updated.endpoint_id,
        },
        {
          jobId: `${updated.id}-replay-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    } catch (queueErr: any) {
      console.warn('[Outbox Replay] Failed to enqueue directly to BullMQ, worker poller will pick it up:', queueErr.message);
    }

    res.status(200).json({
      message: 'Outbox event reset to PENDING for immediate redelivery',
      event: {
        id: updated.id,
        merchant_id: updated.merchant_id,
        endpoint_id: updated.endpoint_id,
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

/**
 * POST /outbox/replay-batch
 * Replays all DEAD_LETTER events for a given webhook endpoint.
 */
export async function replayBatchOutboxEvents(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;
    const { endpoint_id } = req.body;

    if (!endpoint_id || typeof endpoint_id !== 'string') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'endpoint_id is required',
      });
      return;
    }

    // Verify endpoint belongs to this merchant
    const epResult = await query(
      `SELECT id, url, secret FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [endpoint_id, merchantId]
    );

    if (epResult.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Webhook endpoint with ID '${endpoint_id}' not found`,
      });
      return;
    }

    const endpoint = epResult.rows[0];

    // Find all DEAD_LETTER events for this endpoint
    const eventsResult = await query(
      `SELECT id, event_type, payload, target_url, endpoint_id
       FROM outbox_events
       WHERE merchant_id = $1 AND endpoint_id = $2 AND status = 'DEAD_LETTER'`,
      [merchantId, endpoint_id]
    );

    const events = eventsResult.rows;

    if (events.length === 0) {
      res.status(200).json({
        message: 'No DEAD_LETTER events found for this endpoint',
        replayed_count: 0,
        event_ids: [],
      });
      return;
    }

    const eventIds = events.map((e) => e.id);

    // Reset all found events to PENDING
    await query(
      `UPDATE outbox_events
       SET status = 'PENDING', attempts = 0, next_retry_at = NOW()
       WHERE id = ANY($1)`,
      [eventIds]
    );

    // Enqueue jobs in BullMQ
    try {
      const queue = getWebhookQueue();
      for (const evt of events) {
        await queue.add(
          'send-webhook',
          {
            eventId: evt.id,
            eventType: evt.event_type,
            targetUrl: evt.target_url,
            payload: evt.payload,
            attempts: 0,
            secret: endpoint.secret || env.WEBHOOK_SECRET,
            endpointId: evt.endpoint_id,
          },
          {
            jobId: `${evt.id}-batch-replay-${Date.now()}`,
            removeOnComplete: true,
            removeOnFail: true,
          }
        );
      }
    } catch (queueErr: any) {
      console.warn('[Outbox Batch Replay] Queue enqueue error, poller will pick up:', queueErr.message);
    }

    res.status(200).json({
      message: `Successfully queued ${events.length} DEAD_LETTER events for replay`,
      replayed_count: events.length,
      event_ids: eventIds,
    });
  } catch (err) {
    next(err);
  }
}
