import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const INSECURE_DEFAULT_SECRETS = new Set([
  'default-ledgerflow-secret-key-12345',
  'default-admin-token-secret-99999',
  'changeme',
  'password',
  'admin',
  'secret',
  '12345678',
  'ledgerflow',
]);

export const INSECURE_DEFAULT_DB_URLS = new Set([
  'postgres://postgres:postgres@localhost:5432/ledgerflow',
  'postgres://postgres:postgres@127.0.0.1:5432/ledgerflow',
  'postgres://postgres:postgres@localhost:5433/ledgerflow',
  'postgres://postgres:postgres@127.0.0.1:5433/ledgerflow',
]);

/**
 * Strips password credentials from database or Redis connection strings
 * to ensure sensitive secrets are never leaked into structured logs or traces.
 */
export function redactUrl(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '***';
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string().optional(),
    REDIS_URL: z.string().optional(),
    POSTGRES_USER: z.string().optional().default('postgres'),
    POSTGRES_PASSWORD: z.string().optional().default('postgres'),
    POSTGRES_DB: z.string().optional().default('ledgerflow'),
    POSTGRES_PORT: z.coerce.number().optional().default(5432),
    REDIS_PORT: z.coerce.number().optional().default(6379),
    WEBHOOK_SECRET: z.string().optional(),
    ADMIN_TOKEN: z.string().optional(),
    ALLOW_PRIVATE_WEBHOOK_TARGETS: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val.toLowerCase() === 'true';
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
      .union([z.boolean(), z.string()])
      .optional()
      .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val.toLowerCase() === 'true';
        return false;
      }),
    METRICS_TOKEN: z.string().optional(),
    DATABASE_SSL: z.string().optional(),
    DATABASE_SSL_REJECT_UNAUTHORIZED: z.string().optional(),
    RATE_LIMIT_ENABLED: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((val) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val.toLowerCase() === 'true';
        return true;
      }),
    RATE_LIMIT_GLOBAL_MAX: z.coerce
      .number()
      .default(process.env.NODE_ENV === 'test' ? 10000 : 300),
    RATE_LIMIT_TENANT_MAX: z.coerce
      .number()
      .default(process.env.NODE_ENV === 'test' ? 10000 : 1200),
    RATE_LIMIT_AUTH_FAIL_MAX: z.coerce
      .number()
      .default(process.env.NODE_ENV === 'test' ? 1000 : 20),
    RATE_LIMIT_EXPENSIVE_MAX: z.coerce
      .number()
      .default(process.env.NODE_ENV === 'test' ? 10000 : 60),
    BODY_SIZE_LIMIT: z.string().default('256kb'),
    REQUEST_TIMEOUT_MS: z.coerce.number().default(15000),
    TRUST_PROXY: z.string().default('false'),
  })
  .superRefine((data, ctx) => {
    const isProd = data.NODE_ENV === 'production';

    if (isProd) {
      // 1. ADMIN_TOKEN Validation
      if (!data.ADMIN_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_TOKEN'],
          message: 'ADMIN_TOKEN is strictly required in production.',
        });
      } else if (data.ADMIN_TOKEN.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_TOKEN'],
          message: 'ADMIN_TOKEN must be at least 32 characters in production for cryptographic safety.',
        });
      } else if (INSECURE_DEFAULT_SECRETS.has(data.ADMIN_TOKEN.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_TOKEN'],
          message: 'ADMIN_TOKEN cannot be a known insecure default secret in production.',
        });
      }

      // 2. WEBHOOK_SECRET Validation
      if (!data.WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SECRET'],
          message: 'WEBHOOK_SECRET is strictly required in production.',
        });
      } else if (data.WEBHOOK_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SECRET'],
          message: 'WEBHOOK_SECRET must be at least 32 characters in production for cryptographic safety.',
        });
      } else if (INSECURE_DEFAULT_SECRETS.has(data.WEBHOOK_SECRET.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_SECRET'],
          message: 'WEBHOOK_SECRET cannot be a known insecure default secret in production.',
        });
      }

      // 3. DATABASE_URL Validation
      if (!data.DATABASE_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: 'DATABASE_URL is strictly required in production.',
        });
      } else if (INSECURE_DEFAULT_DB_URLS.has(data.DATABASE_URL.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_URL'],
          message: 'DATABASE_URL cannot use insecure default local credentials in production.',
        });
      }

      // 4. DEMO_MODE Prohibited in Production
      if (data.DEMO_MODE === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DEMO_MODE'],
          message: 'DEMO_MODE cannot be enabled in production environments.',
        });
      }

      // 5. ALLOW_PRIVATE_WEBHOOK_TARGETS Prohibited in Production
      if (data.ALLOW_PRIVATE_WEBHOOK_TARGETS === true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ALLOW_PRIVATE_WEBHOOK_TARGETS'],
          message: 'ALLOW_PRIVATE_WEBHOOK_TARGETS cannot be enabled in production environments.',
        });
      }
    }
  })
  .transform((data) => {
    const isProd = data.NODE_ENV === 'production';
    return {
      ...data,
      DATABASE_URL: data.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ledgerflow',
      REDIS_URL: data.REDIS_URL || 'redis://localhost:6379',
      WEBHOOK_SECRET: data.WEBHOOK_SECRET || (isProd ? '' : 'default-ledgerflow-secret-key-12345'),
      ADMIN_TOKEN: data.ADMIN_TOKEN || (isProd ? '' : 'default-admin-token-secret-99999'),
      ALLOW_PRIVATE_WEBHOOK_TARGETS: isProd ? false : Boolean(data.ALLOW_PRIVATE_WEBHOOK_TARGETS),
      DEMO_MODE: isProd ? false : Boolean(data.DEMO_MODE),
    };
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates arbitrary environment key-value objects against the hardened schema.
 * Throws ZodError if invalid.
 */
export function validateEnv(input: Record<string, any>): Env {
  return envSchema.parse(input);
}

/**
 * Returns a sanitized configuration dictionary with passwords and sensitive secrets redacted.
 */
export function getSanitizedConfig(envObj: Env = env) {
  return {
    NODE_ENV: envObj.NODE_ENV,
    PORT: envObj.PORT,
    DATABASE_URL: redactUrl(envObj.DATABASE_URL),
    REDIS_URL: redactUrl(envObj.REDIS_URL),
    DEMO_MODE: envObj.DEMO_MODE,
    ALLOW_PRIVATE_WEBHOOK_TARGETS: envObj.ALLOW_PRIVATE_WEBHOOK_TARGETS,
    IDEMPOTENCY_RETENTION_SECONDS: envObj.IDEMPOTENCY_RETENTION_SECONDS,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: envObj.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    WEBHOOK_RATE_LIMIT_PER_SECOND: envObj.WEBHOOK_RATE_LIMIT_PER_SECOND,
  };
}

export const env: Env = envSchema.parse(process.env);
