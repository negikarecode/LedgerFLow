import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/ledgerflow'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  POSTGRES_USER: z.string().optional().default('postgres'),
  POSTGRES_PASSWORD: z.string().optional().default('postgres'),
  POSTGRES_DB: z.string().optional().default('ledgerflow'),
  POSTGRES_PORT: z.coerce.number().optional().default(5432),
  REDIS_PORT: z.coerce.number().optional().default(6379),
  WEBHOOK_SECRET: z.string().default('default-ledgerflow-secret-key-12345'),
  ADMIN_TOKEN: z.string().default('default-admin-token-secret-99999'),
  ALLOW_PRIVATE_WEBHOOK_TARGETS: z
    .string()
    .optional()
    .transform((val) => {
      if (val !== undefined) return val === 'true';
      return process.env.NODE_ENV !== 'production';
    }),
  IDEMPOTENCY_RETENTION_SECONDS: z.coerce.number().default(86400),
  IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS: z.coerce.number().default(3600),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(10),
  CIRCUIT_BREAKER_COOLDOWN_SECONDS: z.coerce.number().default(30),
  CIRCUIT_BREAKER_ERROR_RATE_THRESHOLD: z.coerce.number().default(0.5),
  WEBHOOK_RATE_LIMIT_PER_SECOND: z.coerce.number().default(10),
  WEBHOOK_RATE_LIMIT_BURST: z.coerce.number().default(20),
  WEBHOOK_MAX_CONCURRENT_PER_ENDPOINT: z.coerce.number().default(3),
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().default(5000),
  WEBHOOK_WORKER_CONCURRENCY: z.coerce.number().default(10),
  DB_POOL_MAX: z.coerce.number().default(60),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
  METRICS_TOKEN: z.string().optional(),
});

export const env = envSchema.parse(process.env);
