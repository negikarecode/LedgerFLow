import { Worker, Job, Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';
import { getRedisClient } from '../redis/client';
import { env } from '../config/env';
import { getClient, query } from '../db/pool';
import { signPayload } from './signature';
import { dispatchSecureWebhook } from '../security/ssrf';
import { cleanupExpiredIdempotencyKeys } from '../api/middlewares/idempotency';

export interface WebhookDeliveryPayload {
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, any>;
  attempts: number;
  secret?: string;
  endpointId?: string;
}

export const QUEUE_NAME = 'webhook-delivery';

let webhookQueueInstance: Queue<WebhookDeliveryPayload> | null = null;

export function getWebhookQueue(): Queue<WebhookDeliveryPayload> {
  if (!webhookQueueInstance) {
    webhookQueueInstance = new Queue<WebhookDeliveryPayload>(QUEUE_NAME, {
      connection: getRedisClient(),
    });
  }
  return webhookQueueInstance;
}

/**
 * Polls eligible PENDING outbox events using FOR UPDATE SKIP LOCKED
 * and enqueues them into BullMQ.
 */
export async function pollAndEnqueueOutboxEvents(batchSize = 20): Promise<number> {
  const client = await getClient();
  const queue = getWebhookQueue();

  try {
    await client.query('BEGIN');

    const selectQuery = `
      SELECT o.id, o.event_type, o.target_url, o.payload, o.attempts, o.endpoint_id,
             e.secret as endpoint_secret
      FROM outbox_events o
      LEFT JOIN webhook_endpoints e ON e.id = o.endpoint_id
      WHERE o.status = 'PENDING'
        AND (o.next_retry_at IS NULL OR o.next_retry_at <= NOW())
      ORDER BY o.created_at ASC
      LIMIT $1
      FOR UPDATE OF o SKIP LOCKED;
    `;
    const result = await client.query(selectQuery, [batchSize]);

    if (result.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const eventIds = result.rows.map((r) => r.id);

    // Prevent immediate re-poll while in flight (30-second lease)
    await client.query(
      `UPDATE outbox_events 
       SET next_retry_at = NOW() + INTERVAL '30 seconds' 
       WHERE id = ANY($1)`,
      [eventIds]
    );

    await client.query('COMMIT');

    // Enqueue jobs in BullMQ
    for (const row of result.rows) {
      await queue.add(
        'send-webhook',
        {
          eventId: row.id,
          eventType: row.event_type,
          targetUrl: row.target_url,
          payload: row.payload,
          attempts: Number(row.attempts),
          secret: row.endpoint_secret || env.WEBHOOK_SECRET,
          endpointId: row.endpoint_id,
        },
        {
          jobId: `${row.id}-${row.attempts}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    }

    return result.rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Executes a single webhook HTTP dispatch, records outcome, writes to delivery_attempts log,
 * and manages backoff/dead-lettering.
 */
export async function processOutboxDelivery(
  data: WebhookDeliveryPayload
): Promise<{ delivered: boolean; deadLetter?: boolean; error?: string; attemptId?: string }> {
  const startedAt = new Date();
  const startTime = performance.now();
  const deliveryId = uuidv4();

  // Attach stable event_id and unique delivery_id to payload
  const outgoingPayload = {
    ...data.payload,
    event_id: data.payload?.event_id || data.eventId,
    delivery_id: deliveryId,
  };
  const payloadString = JSON.stringify(outgoingPayload);
  const signingSecret = data.secret || env.WEBHOOK_SECRET;
  const { signatureHeader } = signPayload(payloadString, signingSecret);

  let success = false;
  let httpStatus: number | null = null;
  let errorMessage: string | null = null;

  try {
    const response = await dispatchSecureWebhook({
      url: data.targetUrl,
      payload: payloadString,
      headers: {
        'X-LedgerFlow-Signature': signatureHeader,
        'X-LedgerFlow-Event-Id': data.eventId,
        'X-LedgerFlow-Delivery-Id': deliveryId,
      },
      timeoutMs: 5000,
    });

    httpStatus = response.statusCode;

    if (response.statusCode >= 200 && response.statusCode < 300) {
      success = true;
    } else {
      errorMessage = (response.body || response.statusText || `HTTP ${response.statusCode}`).slice(0, 1024);
    }
  } catch (err: any) {
    httpStatus = null;
    errorMessage = (err.message || 'Network request failed').slice(0, 1024);
  }

  const durationMs = Math.round(performance.now() - startTime);
  const nextAttempts = data.attempts + 1;
  let nextRetryAt: Date | null = null;
  let deadLetter = false;

  if (success) {
    // Mark DELIVERED
    await query(
      `UPDATE outbox_events 
       SET status = 'DELIVERED', attempts = $2, next_retry_at = NULL 
       WHERE id = $1`,
      [data.eventId, nextAttempts]
    );
  } else {
    if (nextAttempts >= 5) {
      // Reached max retries -> DEAD_LETTER
      deadLetter = true;
      await query(
        `UPDATE outbox_events 
         SET status = 'DEAD_LETTER', attempts = $2, next_retry_at = NULL 
         WHERE id = $1`,
        [data.eventId, nextAttempts]
      );
    } else {
      // Exponential backoff: 2^attempts + jitter
      const backoffSeconds = Math.pow(2, nextAttempts) + Math.random() * 0.5;
      const retryRes = await query(
        `UPDATE outbox_events 
         SET attempts = $2, next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL 
         WHERE id = $1
         RETURNING next_retry_at`,
        [data.eventId, nextAttempts, `${backoffSeconds}`]
      );
      nextRetryAt = retryRes.rows[0]?.next_retry_at || null;
    }
  }

  // Record delivery attempt in delivery_attempts table
  try {
    await query(
      `INSERT INTO delivery_attempts (
        id, outbox_event_id, attempt_number, started_at, duration_ms,
        http_status, error_message, request_signature, next_retry_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        deliveryId,
        data.eventId,
        nextAttempts,
        startedAt,
        durationMs,
        httpStatus,
        errorMessage,
        signatureHeader,
        nextRetryAt,
      ]
    );
  } catch (recordErr: any) {
    console.warn('[Webhook Worker] Failed to write delivery attempt row:', recordErr.message);
  }

  return {
    delivered: success,
    deadLetter,
    error: errorMessage || undefined,
    attemptId: deliveryId,
  };
}

/**
 * Starts the BullMQ worker for the 'webhook-delivery' queue.
 */
export function startWebhookWorker(): {
  worker: Worker<WebhookDeliveryPayload>;
  queue: Queue<WebhookDeliveryPayload>;
  stop: () => Promise<void>;
} {
  const connection = getRedisClient();
  const queue = getWebhookQueue();

  const worker = new Worker<WebhookDeliveryPayload>(
    QUEUE_NAME,
    async (job: Job<WebhookDeliveryPayload>) => {
      console.log(
        `[Webhook Worker] Processing event ${job.data.eventId} -> ${job.data.targetUrl}`
      );
      return await processOutboxDelivery(job.data);
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('ready', () => {
    console.log(`[Webhook Worker] Listening for jobs on '${QUEUE_NAME}'...`);
  });

  worker.on('completed', (job: Job) => {
    console.log(`[Webhook Worker] Job ${job.id} completed.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[Webhook Worker] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err: Error) => {
    console.error('[Webhook Worker] Unexpected worker error:', err);
  });

  let pollerRunning = true;
  let pollerTimeout: NodeJS.Timeout | null = null;

  const runPoller = async () => {
    if (!pollerRunning) return;
    try {
      await pollAndEnqueueOutboxEvents();
    } catch (err: any) {
      console.error('[Outbox Poller] Error during poll cycle:', err.message);
    }
    if (pollerRunning) {
      pollerTimeout = setTimeout(runPoller, 1000);
    }
  };

  runPoller();

  // Scheduled Idempotency Cleanup Poller
  let cleanupRunning = true;
  let cleanupTimeout: NodeJS.Timeout | null = null;

  const runCleanup = async () => {
    if (!cleanupRunning) return;
    try {
      const deletedCount = await cleanupExpiredIdempotencyKeys();
      if (deletedCount > 0) {
        console.log(`[Idempotency Cleanup] Pruned ${deletedCount} expired idempotency keys.`);
      }
    } catch (err: any) {
      console.error('[Idempotency Cleanup] Error pruning expired keys:', err.message);
    }
    if (cleanupRunning) {
      cleanupTimeout = setTimeout(
        runCleanup,
        env.IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS * 1000
      );
    }
  };

  cleanupTimeout = setTimeout(runCleanup, 5000);

  const stop = async () => {
    pollerRunning = false;
    cleanupRunning = false;
    if (pollerTimeout) {
      clearTimeout(pollerTimeout);
      pollerTimeout = null;
    }
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      cleanupTimeout = null;
    }
    await worker.close();
    await queue.close();
    webhookQueueInstance = null;
  };

  return { worker, queue, stop };
}

// Entrypoint when invoked directly via CLI (e.g. npm run worker:dev)
if (require.main === module) {
  console.log('[Webhook Worker] Initializing LedgerFlow outbox poller & webhook worker...');
  const { stop } = startWebhookWorker();

  const shutdown = async (signal: string) => {
    console.log(`[Webhook Worker] Received ${signal}. Shutting down worker...`);
    await stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
