import { Worker, Job, Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import { performance } from 'perf_hooks';
import { getRedisClient, createBullMQRedisClient, calculateRedisBackoff } from '../redis/client';
import { env } from '../config/env';
import { getClient, query } from '../db/pool';
import { signPayload } from './signature';
import { dispatchSecureWebhook } from '../security/ssrf';
import { cleanupExpiredIdempotencyKeys } from '../api/middlewares/idempotency';
import { circuitBreaker, EndpointCircuitBreaker } from './circuit-breaker';
import { rateLimiter, EndpointRateLimiter } from './rate-limiter';
import { concurrencyLimiter, EndpointConcurrencyLimiter } from './concurrency-limiter';
import { createWorkerLogger, logger } from '../observability/logger';
import {
  webhookDeliveryDurationSeconds,
  webhookDeliveriesTotal,
  updateSystemMetrics,
  outboxPollerErrorsTotal,
} from '../observability/metrics';

export { circuitBreaker, rateLimiter, concurrencyLimiter };
export { EndpointCircuitBreaker, EndpointRateLimiter, EndpointConcurrencyLimiter };

export interface WebhookDeliveryPayload {
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, any>;
  attempts: number;
  secret?: string;
  endpointId?: string;
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
  requestId?: string;
}

export const QUEUE_NAME = 'webhook-delivery';

let webhookQueueInstance: Queue<WebhookDeliveryPayload> | null = null;

export function getWebhookQueue(): Queue<WebhookDeliveryPayload> {
  if (!webhookQueueInstance) {
    const queueConn = createBullMQRedisClient();
    webhookQueueInstance = new Queue<WebhookDeliveryPayload>(QUEUE_NAME, {
      connection: queueConn,
    });
    webhookQueueInstance.on('error', (err: Error) => {
      logger.error(
        { event: 'bullmq_queue_error', error: err.message },
        `[BullMQ Queue] Connection/Queue error: ${err.message}`
      );
    });
  }
  return webhookQueueInstance;
}

/**
 * Polls eligible PENDING outbox events using fair endpoint partitioning
 * with FOR UPDATE SKIP LOCKED and enqueues them into BullMQ.
 */
export async function pollAndEnqueueOutboxEvents(batchSize = 100): Promise<number> {
  const queue = getWebhookQueue();

  // Guard: if Queue Redis connection is not ready, avoid leasing database rows that cannot be enqueued
  const queueConn = (queue as any).opts?.connection || getRedisClient();
  if (queueConn && typeof queueConn.status === 'string' && queueConn.status !== 'ready') {
    return 0;
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Interleave events across endpoints so a single dead or overloaded endpoint
    // cannot monopolize the polled batch (starvation prevention).
    const selectQuery = `
      WITH eligible AS (
        SELECT o.id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(o.endpoint_id, '00000000-0000-0000-0000-000000000000'::UUID)
                 ORDER BY o.created_at ASC
               ) as ep_rank
        FROM outbox_events o
        WHERE o.status = 'PENDING'
          AND (o.next_retry_at IS NULL OR o.next_retry_at <= NOW())
        ORDER BY ep_rank ASC, o.created_at ASC
        LIMIT $1
      )
      SELECT o.id, o.event_type, o.target_url, o.payload, o.attempts, o.endpoint_id, o.request_id,
             e.secret as endpoint_secret,
             e.rate_limit_per_second, e.rate_limit_burst
      FROM outbox_events o
      JOIN eligible el ON o.id = el.id
      LEFT JOIN webhook_endpoints e ON e.id = o.endpoint_id
      ORDER BY el.ep_rank ASC, o.created_at ASC
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
          rateLimitPerSecond: row.rate_limit_per_second,
          rateLimitBurst: row.rate_limit_burst,
          requestId: row.request_id || row.payload?.request_id,
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
 * and manages circuit breaker, token bucket rate limits, in-flight concurrency, and backoff.
 */
export async function processOutboxDelivery(
  data: WebhookDeliveryPayload
): Promise<{
  delivered: boolean;
  deadLetter?: boolean;
  error?: string;
  attemptId?: string;
  rescheduled?: boolean;
  reason?: string;
  delayMs?: number;
}> {
  const startedAt = new Date();
  const startTime = performance.now();
  const deliveryId = uuidv4();
  const reqId = data.requestId || data.payload?.request_id || null;

  const workerLog = createWorkerLogger({
    reqId: reqId || undefined,
    eventId: data.eventId,
    deliveryId,
    endpointId: data.endpointId,
  });

  let isProbe = false;

  // 1. Per-Endpoint Isolation Checks (Circuit Breaker, Rate Limit, In-Flight Concurrency)
  if (data.endpointId) {
    // 1a. Circuit Breaker Check
    const cbCheck = await circuitBreaker.canAttemptDelivery(data.endpointId);
    if (!cbCheck.allowed) {
      const delayMs = cbCheck.delayMs || 5000;
      webhookDeliveriesTotal.inc({
        result: 'circuit_breaker_open',
        endpoint_id: data.endpointId || 'none',
      });
      workerLog.warn(
        { state: cbCheck.state, delayMs },
        `[Webhook Worker] Circuit breaker is ${cbCheck.state} for endpoint ${data.endpointId}. Rescheduling event ${data.eventId} in ${delayMs}ms without burning attempt.`
      );
      await query(
        `UPDATE outbox_events 
         SET next_retry_at = NOW() + ($2 || ' milliseconds')::INTERVAL 
         WHERE id = $1`,
        [data.eventId, `${delayMs}`]
      );
      return {
        delivered: false,
        rescheduled: true,
        reason: `CIRCUIT_BREAKER_${cbCheck.state}`,
        delayMs,
      };
    }
    isProbe = Boolean(cbCheck.isProbe);

    // 1b. Token Bucket Rate Limit Check (Lua in Redis)
    const rlCheck = await rateLimiter.consume(
      data.endpointId,
      data.rateLimitPerSecond,
      data.rateLimitBurst
    );
    if (!rlCheck.allowed) {
      const delayMs = rlCheck.waitMs;
      webhookDeliveriesTotal.inc({
        result: 'rate_limited',
        endpoint_id: data.endpointId || 'none',
      });
      workerLog.warn(
        { delayMs },
        `[Webhook Worker] Rate limit reached for endpoint ${data.endpointId}. Rescheduling event ${data.eventId} in ${delayMs}ms without burning attempt.`
      );
      await query(
        `UPDATE outbox_events 
         SET next_retry_at = NOW() + ($2 || ' milliseconds')::INTERVAL 
         WHERE id = $1`,
        [data.eventId, `${delayMs}`]
      );
      return {
        delivered: false,
        rescheduled: true,
        reason: 'RATE_LIMITED',
        delayMs,
      };
    }

    // 1c. In-Flight Concurrency Limiter (prevent slow endpoints from starving worker threads)
    const concCheck = await concurrencyLimiter.acquire(data.endpointId);
    if (!concCheck.allowed) {
      const delayMs = 250;
      await query(
        `UPDATE outbox_events 
         SET next_retry_at = NOW() + INTERVAL '250 milliseconds' 
         WHERE id = $1`,
        [data.eventId]
      );
      return {
        delivered: false,
        rescheduled: true,
        reason: 'CONCURRENCY_LIMITED',
        delayMs,
      };
    }
  }

  // Attach stable event_id and unique delivery_id to payload
  const outgoingPayload = {
    ...data.payload,
    event_id: data.payload?.event_id || data.eventId,
    delivery_id: deliveryId,
  };
  const payloadString = JSON.stringify(outgoingPayload);
  const signingSecret = data.secret || env.WEBHOOK_SECRET;
  const { signatureHeader } = signPayload(payloadString, signingSecret, { deliveryId });

  let success = false;
  let httpStatus: number | null = null;
  let errorMessage: string | null = null;

  try {
    const hardTimeoutMs = env.WEBHOOK_DELIVERY_TIMEOUT_MS;
    const timeoutPromise = new Promise<{ statusCode: number; statusText?: string; body?: string }>(
      (_, reject) =>
        setTimeout(
          () => reject(new Error(`Webhook dispatch timed out after ${hardTimeoutMs}ms`)),
          hardTimeoutMs + 500
        )
    );

    const response = await Promise.race([
      dispatchSecureWebhook({
        url: data.targetUrl,
        payload: payloadString,
        headers: {
          'X-LedgerFlow-Signature': signatureHeader,
          'X-LedgerFlow-Event-Id': data.eventId,
          'X-LedgerFlow-Delivery-Id': deliveryId,
          ...(reqId ? { 'X-Request-Id': reqId } : {}),
        },
        timeoutMs: hardTimeoutMs,
      }),
      timeoutPromise,
    ]);

    httpStatus = response.statusCode;

    if (response.statusCode >= 200 && response.statusCode < 300) {
      success = true;
    } else {
      errorMessage = (response.body || response.statusText || `HTTP ${response.statusCode}`).slice(0, 1024);
    }
  } catch (err: any) {
    httpStatus = null;
    errorMessage = (err.message || 'Network request failed').slice(0, 1024);
  } finally {
    if (data.endpointId) {
      await concurrencyLimiter.release(data.endpointId);
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  // Update Circuit Breaker State based on dispatch outcome
  if (data.endpointId) {
    if (success) {
      await circuitBreaker.recordSuccess(data.endpointId, isProbe);
    } else {
      await circuitBreaker.recordFailure(data.endpointId, isProbe);
    }
  }

  // Record Prometheus metrics
  webhookDeliveryDurationSeconds.observe(
    {
      status_code: httpStatus ? httpStatus.toString() : 'error',
      endpoint_id: data.endpointId || 'none',
    },
    durationMs / 1000
  );

  const deliveryResult = success
    ? 'success'
    : httpStatus
    ? 'failure'
    : 'timeout_or_error';
  webhookDeliveriesTotal.inc({
    result: deliveryResult,
    endpoint_id: data.endpointId || 'none',
  });

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

  if (success) {
    workerLog.info({ httpStatus, durationMs }, 'Webhook delivered successfully');
  } else {
    workerLog.warn(
      { httpStatus, durationMs, errorMessage, deadLetter },
      'Webhook delivery attempt failed'
    );
  }

  // Record delivery attempt in delivery_attempts table
  try {
    await query(
      `INSERT INTO delivery_attempts (
        id, outbox_event_id, attempt_number, started_at, duration_ms,
        http_status, error_message, request_signature, next_retry_at, request_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        reqId,
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
  const connection = createBullMQRedisClient();
  const queue = getWebhookQueue();

  const worker = new Worker<WebhookDeliveryPayload>(
    QUEUE_NAME,
    async (job: Job<WebhookDeliveryPayload>) => {
      logger.info(
        { event: 'webhook_worker_job_start', eventId: job.data.eventId, targetUrl: job.data.targetUrl },
        `[Webhook Worker] Processing event ${job.data.eventId} -> ${job.data.targetUrl}`
      );
      return await processOutboxDelivery(job.data);
    },
    {
      connection,
      concurrency: env.WEBHOOK_WORKER_CONCURRENCY,
    }
  );

  worker.on('ready', () => {
    logger.info(
      { event: 'webhook_worker_ready', queue: QUEUE_NAME, concurrency: env.WEBHOOK_WORKER_CONCURRENCY },
      `[Webhook Worker] Listening for jobs on '${QUEUE_NAME}' with concurrency ${env.WEBHOOK_WORKER_CONCURRENCY}...`
    );
  });

  worker.on('completed', (job: Job) => {
    logger.info(
      { event: 'webhook_worker_job_completed', jobId: job.id },
      `[Webhook Worker] Job ${job.id} completed.`
    );
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    logger.error(
      { event: 'webhook_worker_job_failed', jobId: job?.id, error: err.message },
      `[Webhook Worker] Job ${job?.id} failed: ${err.message}`
    );
  });

  worker.on('error', (err: Error) => {
    logger.error(
      { event: 'webhook_worker_error', error: err.message },
      `[Webhook Worker] Unexpected worker error: ${err.message}`
    );
  });

  let pollerRunning = true;
  let pollerTimeout: NodeJS.Timeout | null = null;
  let consecutiveErrors = 0;

  const runPoller = async () => {
    if (!pollerRunning) return;
    let nextDelay = 1000;
    try {
      const enqueued = await pollAndEnqueueOutboxEvents(100);
      consecutiveErrors = 0;
      // Adaptive backoff: if events were enqueued, poll immediately (50ms) to drain backlog without latency
      if (enqueued > 0) {
        nextDelay = 50;
      }
    } catch (err: any) {
      consecutiveErrors++;
      outboxPollerErrorsTotal.inc();
      nextDelay = calculateRedisBackoff(consecutiveErrors, {
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        jitterRatio: 0.3,
      });
      logger.error(
        {
          event: 'outbox_poller_error',
          consecutive_errors: consecutiveErrors,
          next_retry_delay_ms: nextDelay,
          error: err.message,
        },
        `[Outbox Poller] Error during poll cycle: ${err.message}. Backing off for ${nextDelay}ms`
      );
    }
    if (pollerRunning) {
      pollerTimeout = setTimeout(runPoller, nextDelay);
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
        logger.info(
          { event: 'idempotency_cleanup', deleted_count: deletedCount },
          `[Idempotency Cleanup] Pruned ${deletedCount} expired idempotency keys.`
        );
      }
    } catch (err: any) {
      logger.error(
        { event: 'idempotency_cleanup_error', error: err.message },
        `[Idempotency Cleanup] Error pruning expired keys: ${err.message}`
      );
    }
    if (cleanupRunning) {
      cleanupTimeout = setTimeout(
        runCleanup,
        env.IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS * 1000
      );
    }
  };

  cleanupTimeout = setTimeout(runCleanup, 5000);

  // Scheduled Periodic System Metrics Updater
  let metricsRunning = true;
  let metricsTimeout: NodeJS.Timeout | null = null;

  const runMetrics = async () => {
    if (!metricsRunning) return;
    try {
      await updateSystemMetrics();
    } catch (err: any) {
      // Non-fatal
    }
    if (metricsRunning) {
      metricsTimeout = setTimeout(runMetrics, 15000);
    }
  };

  metricsTimeout = setTimeout(runMetrics, 2000);

  const stop = async () => {
    pollerRunning = false;
    cleanupRunning = false;
    metricsRunning = false;
    if (pollerTimeout) {
      clearTimeout(pollerTimeout);
      pollerTimeout = null;
    }
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      cleanupTimeout = null;
    }
    if (metricsTimeout) {
      clearTimeout(metricsTimeout);
      metricsTimeout = null;
    }

    try {
      await Promise.race([
        worker.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Worker close timeout')), 2000)),
      ]);
    } catch (err: any) {
      logger.warn(
        { event: 'worker_close_warning', error: err.message },
        `[Webhook Worker] Worker close error or timeout: ${err.message}`
      );
    }

    try {
      await Promise.race([
        queue.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Queue close timeout')), 2000)),
      ]);
    } catch (err: any) {
      logger.warn(
        { event: 'queue_close_warning', error: err.message },
        `[Webhook Worker] Queue close error or timeout: ${err.message}`
      );
    }

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
