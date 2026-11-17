import { Worker, Job, Queue } from 'bullmq';
import { getRedisClient } from '../redis/client';
import { env } from '../config/env';
import { getClient, query } from '../db/pool';
import { signPayload } from './signature';

export interface WebhookDeliveryPayload {
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, any>;
  attempts: number;
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
      SELECT id, event_type, target_url, payload, attempts
      FROM outbox_events
      WHERE status = 'PENDING'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED;
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
 * Executes a single webhook HTTP dispatch, records outcome, and manages backoff/dead-lettering.
 */
export async function processOutboxDelivery(
  data: WebhookDeliveryPayload
): Promise<{ delivered: boolean; deadLetter?: boolean; error?: string }> {
  const payloadString = JSON.stringify(data.payload);
  const { signatureHeader } = signPayload(payloadString, env.WEBHOOK_SECRET);

  let success = false;
  let errorReason = '';

  try {
    const response = await fetch(data.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LedgerFlow-Signature': signatureHeader,
      },
      body: payloadString,
      signal: AbortSignal.timeout(5000), // 5-second timeout
    });

    if (response.ok) {
      success = true;
    } else {
      errorReason = `HTTP ${response.status} ${response.statusText}`;
    }
  } catch (err: any) {
    errorReason = err.message || 'Network request failed';
  }

  if (success) {
    // Mark DELIVERED
    await query(
      `UPDATE outbox_events 
       SET status = 'DELIVERED', next_retry_at = NULL 
       WHERE id = $1`,
      [data.eventId]
    );
    return { delivered: true };
  } else {
    // Increment attempts and compute exponential backoff
    const nextAttempts = data.attempts + 1;

    if (nextAttempts >= 5) {
      // Reached max retries -> DEAD_LETTER
      await query(
        `UPDATE outbox_events 
         SET status = 'DEAD_LETTER', attempts = $2, next_retry_at = NULL 
         WHERE id = $1`,
        [data.eventId, nextAttempts]
      );
      return { delivered: false, deadLetter: true, error: errorReason };
    } else {
      // Backoff: 2^attempts + jitter
      const backoffSeconds = Math.pow(2, nextAttempts) + Math.random() * 0.5;
      await query(
        `UPDATE outbox_events 
         SET attempts = $2, next_retry_at = NOW() + ($3 || ' seconds')::INTERVAL 
         WHERE id = $1`,
        [data.eventId, nextAttempts, `${backoffSeconds}`]
      );
      return { delivered: false, deadLetter: false, error: errorReason };
    }
  }
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

  const stop = async () => {
    pollerRunning = false;
    if (pollerTimeout) {
      clearTimeout(pollerTimeout);
      pollerTimeout = null;
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
