import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../redis/client';
import { env } from '../config/env';

export interface WebhookDeliveryPayload {
  eventId: string;
  eventType: string;
  targetUrl: string;
  payload: Record<string, any>;
  attempt: number;
}

const QUEUE_NAME = 'webhook-delivery';

/**
 * Placeholder entry point for BullMQ webhook worker.
 * Consumes webhook delivery jobs from the 'webhook-delivery' queue.
 */
export function startWebhookWorker(): Worker<WebhookDeliveryPayload> {
  const connection = getRedisClient();

  const worker = new Worker<WebhookDeliveryPayload>(
    QUEUE_NAME,
    async (job: Job<WebhookDeliveryPayload>) => {
      console.log(`[Webhook Worker] Processing job ${job.id} for event ${job.data.eventId} -> ${job.data.targetUrl}`);
      
      // Placeholder for actual webhook HTTP dispatch logic (Phase 2)
      // e.g., send signed payload, record response status, manage exponential backoff
      
      return {
        delivered: true,
        statusCode: 200,
        timestamp: new Date().toISOString(),
      };
    },
    {
      connection,
      concurrency: 5,
    }
  );

  worker.on('ready', () => {
    console.log(`[Webhook Worker] Listening for jobs on queue '${QUEUE_NAME}'...`);
  });

  worker.on('completed', (job: Job) => {
    console.log(`[Webhook Worker] Job ${job.id} completed successfully.`);
  });

  worker.on('failed', (job: Job | undefined, err: Error) => {
    console.error(`[Webhook Worker] Job ${job?.id} failed with error: ${err.message}`);
  });

  worker.on('error', (err: Error) => {
    console.error('[Webhook Worker] Unexpected worker error:', err);
  });

  return worker;
}

if (require.main === module) {
  console.log('[Webhook Worker] Starting LedgerFlow webhook worker...');
  const worker = startWebhookWorker();

  const shutdown = async (signal: string) => {
    console.log(`[Webhook Worker] Received ${signal}. Closing worker...`);
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
