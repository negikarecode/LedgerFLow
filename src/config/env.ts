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
    .default('false')
    .transform((val) => val === 'true'),
  IDEMPOTENCY_RETENTION_SECONDS: z.coerce.number().default(86400),
  IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS: z.coerce.number().default(3600),
});

export const env = envSchema.parse(process.env);
