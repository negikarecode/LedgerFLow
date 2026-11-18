import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { validateEnv, redactUrl } from '../src/config/env';
import { requireDemoMode } from '../src/api/middlewares/demo.middleware';
import { errorHandler } from '../src/api/middlewares/error.middleware';
import { validateWebhookUrl, SSRFError } from '../src/security/ssrf';

describe('LedgerFlow Production Hardening & Configuration Suite', () => {
  const validProdToken = '0123456789abcdef0123456789abcdef0123456789abcdef';
  const validProdSecret = 'fedcba9876543210fedcba9876543210fedcba9876543210';
  const validProdDbUrl = 'postgres://prod_user:strong_prod_pass@db.internal:5432/ledgerflow_production';
  const validProdRedisUrl = 'redis://redis.internal:6379';

  describe('1. Production Fail-Fast Environment Validation', () => {
    it('should fail fast in production when ADMIN_TOKEN is missing', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          DATABASE_URL: validProdDbUrl,
          WEBHOOK_SECRET: validProdSecret,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/ADMIN_TOKEN is strictly required in production/i);
    });

    it('should fail fast in production when ADMIN_TOKEN is shorter than 32 characters', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: 'too-short-token',
          DATABASE_URL: validProdDbUrl,
          WEBHOOK_SECRET: validProdSecret,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/at least 32 characters in production/i);
    });

    it('should fail fast in production when ADMIN_TOKEN is the default insecure placeholder', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: 'default-admin-token-secret-99999',
          DATABASE_URL: validProdDbUrl,
          WEBHOOK_SECRET: validProdSecret,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/cannot be a known insecure default secret/i);
    });

    it('should fail fast in production when WEBHOOK_SECRET is missing', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          DATABASE_URL: validProdDbUrl,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/WEBHOOK_SECRET is strictly required in production/i);
    });

    it('should fail fast in production when WEBHOOK_SECRET is shorter than 32 characters', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: 'weak-secret',
          DATABASE_URL: validProdDbUrl,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/at least 32 characters in production/i);
    });

    it('should fail fast in production when WEBHOOK_SECRET is the default insecure placeholder', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: 'default-ledgerflow-secret-key-12345',
          DATABASE_URL: validProdDbUrl,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/cannot be a known insecure default secret/i);
    });

    it('should fail fast in production when DATABASE_URL is missing', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: validProdSecret,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/DATABASE_URL is strictly required in production/i);
    });

    it('should fail fast in production when DATABASE_URL uses insecure default local credentials', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: validProdSecret,
          DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/ledgerflow',
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/DATABASE_URL cannot use insecure default local credentials/i);
    });

    it('should fail fast in production when DEMO_MODE is set to true', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: validProdSecret,
          DATABASE_URL: validProdDbUrl,
          DEMO_MODE: 'true',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
        })
      ).toThrow(/DEMO_MODE cannot be enabled in production/i);
    });

    it('should fail fast in production when ALLOW_PRIVATE_WEBHOOK_TARGETS is set to true', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          ADMIN_TOKEN: validProdToken,
          WEBHOOK_SECRET: validProdSecret,
          DATABASE_URL: validProdDbUrl,
          DEMO_MODE: 'false',
          ALLOW_PRIVATE_WEBHOOK_TARGETS: 'true',
        })
      ).toThrow(/ALLOW_PRIVATE_WEBHOOK_TARGETS cannot be enabled in production/i);
    });

    it('should pass cleanly in production with valid strong secrets and safe flags', () => {
      const parsed = validateEnv({
        NODE_ENV: 'production',
        ADMIN_TOKEN: validProdToken,
        WEBHOOK_SECRET: validProdSecret,
        DATABASE_URL: validProdDbUrl,
        REDIS_URL: validProdRedisUrl,
        DEMO_MODE: 'false',
        ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false',
      });

      expect(parsed.NODE_ENV).toBe('production');
      expect(parsed.ADMIN_TOKEN).toBe(validProdToken);
      expect(parsed.WEBHOOK_SECRET).toBe(validProdSecret);
      expect(parsed.DEMO_MODE).toBe(false);
      expect(parsed.ALLOW_PRIVATE_WEBHOOK_TARGETS).toBe(false);
    });
  });

  describe('2. Development & Test Environment Compatibility', () => {
    it('should accept defaults in development mode without breaking local demo setup', () => {
      const parsed = validateEnv({
        NODE_ENV: 'development',
      });

      expect(parsed.NODE_ENV).toBe('development');
      expect(parsed.ADMIN_TOKEN).toBe('default-admin-token-secret-99999');
      expect(parsed.WEBHOOK_SECRET).toBe('default-ledgerflow-secret-key-12345');
      expect(parsed.DATABASE_URL).toBeDefined();
      expect(parsed.REDIS_URL).toBeDefined();
    });

    it('should accept defaults in test mode without breaking test suite', () => {
      const parsed = validateEnv({
        NODE_ENV: 'test',
      });

      expect(parsed.NODE_ENV).toBe('test');
      expect(parsed.ADMIN_TOKEN).toBe('default-admin-token-secret-99999');
      expect(parsed.WEBHOOK_SECRET).toBe('default-ledgerflow-secret-key-12345');
    });

    it('should permit DEMO_MODE=true in development environments', () => {
      const parsed = validateEnv({
        NODE_ENV: 'development',
        DEMO_MODE: 'true',
      });

      expect(parsed.DEMO_MODE).toBe(true);
    });
  });

  describe('3. Secret Masking & Redaction', () => {
    it('should redact database passwords from postgres connection strings', () => {
      const redacted = redactUrl('postgres://user:super_secret_pw@db.cloud.com:5432/ledgerflow');
      expect(redacted).toBe('postgres://user:***@db.cloud.com:5432/ledgerflow');
      expect(redacted).not.toContain('super_secret_pw');
    });

    it('should redact redis passwords from redis connection strings', () => {
      const redacted = redactUrl('redis://:my_auth_token_99@cache.cloud.com:6379');
      expect(redacted).toBe('redis://:***@cache.cloud.com:6379');
      expect(redacted).not.toContain('my_auth_token_99');
    });

    it('should handle URLs without passwords cleanly', () => {
      const redacted = redactUrl('redis://localhost:6379');
      expect(redacted).toBe('redis://localhost:6379');
    });

    it('should handle undefined or empty strings safely without throwing', () => {
      expect(redactUrl(undefined)).toBe('');
      expect(redactUrl('')).toBe('');
      expect(redactUrl('not-a-valid-url')).toBe('***');
    });
  });

  describe('4. Runtime Middleware Gating & SSRF Lockdown in Production', () => {
    it('requireDemoMode should return 403 Forbidden in production regardless of request flags', () => {
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      let statusCode: number | null = null;
      let jsonPayload: any = null;

      const mockReq: any = {};
      const mockRes: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return this;
        },
      };
      const mockNext = () => {};

      try {
        requireDemoMode(mockReq, mockRes, mockNext);
        expect(statusCode).toBe(403);
        expect(jsonPayload.error).toBe('DEMO_MODE_FORBIDDEN_IN_PRODUCTION');
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }
    });

    it('validateWebhookUrl should block private targets in production even if allowPrivate=true was requested', async () => {
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      try {
        await expect(
          validateWebhookUrl('http://127.0.0.1:3000/webhook', { allowPrivate: true })
        ).rejects.toThrow(SSRFError);

        await expect(
          validateWebhookUrl('http://169.254.169.254/latest/meta-data', { allowPrivate: true })
        ).rejects.toThrow(SSRFError);
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }
    });

    it('errorHandler should withhold internal 500 error messages and stacks in production', () => {
      const origNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      let statusCode: number | null = null;
      let jsonPayload: any = null;

      const mockErr = new Error('Database connection failed: role "superadmin" does not exist at postgres.internal:5432');
      const mockReq: any = { method: 'POST', originalUrl: '/transfers' };
      const mockRes: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        json(data: any) {
          jsonPayload = data;
          return this;
        },
      };

      try {
        errorHandler(mockErr, mockReq, mockRes, () => {});
        expect(statusCode).toBe(500);
        expect(jsonPayload.error).toBe('Internal Server Error');
        expect(jsonPayload.message).toBe('An unexpected internal error occurred');
        expect(jsonPayload.message).not.toContain('superadmin');
      } finally {
        process.env.NODE_ENV = origNodeEnv;
      }
    });
  });

  describe('5. Dockerfile, Docker Compose & .env.example Validation', () => {
    it('.env.example should contain placeholders only and no insecure default credentials', () => {
      const envExamplePath = path.join(process.cwd(), '.env.example');
      const content = fs.readFileSync(envExamplePath, 'utf8');

      expect(content).not.toContain('default-ledgerflow-secret-key-12345');
      expect(content).not.toContain('default-admin-token-secret-99999');
      expect(content).toContain('YOUR_RANDOM_WEBHOOK_SECRET_MIN_32_CHARS_PLACEHOLDER');
      expect(content).toContain('YOUR_RANDOM_ADMIN_TOKEN_MIN_32_CHARS_PLACEHOLDER');
    });

    it('Dockerfile should configure unprivileged USER node and container HEALTHCHECK', () => {
      const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
      const content = fs.readFileSync(dockerfilePath, 'utf8');

      expect(content).toContain('USER node');
      expect(content).toContain('HEALTHCHECK');
      expect(content).toContain('/health/live');
    });

    it('docker-compose.prod.yml should isolate database and redis without exposed host ports', () => {
      const prodComposePath = path.join(process.cwd(), 'docker-compose.prod.yml');
      const content = fs.readFileSync(prodComposePath, 'utf8');

      // Ensure ports are not publicly mapped for postgres and redis in production
      expect(content).toContain('ledgerflow_prod_postgres');
      expect(content).toContain('expose:');
      expect(content).toContain('- "5432"');
      expect(content).toContain('user: "node"');
      expect(content).toContain('ADMIN_TOKEN: ${ADMIN_TOKEN:?ADMIN_TOKEN is required in production}');
      expect(content).toContain('WEBHOOK_SECRET: ${WEBHOOK_SECRET:?WEBHOOK_SECRET is required in production}');
    });

    it('docker-compose.yml development should bind database and redis to 127.0.0.1', () => {
      const devComposePath = path.join(process.cwd(), 'docker-compose.yml');
      const content = fs.readFileSync(devComposePath, 'utf8');

      expect(content).toContain('127.0.0.1:${POSTGRES_PORT:-5432}:5432');
      expect(content).toContain('127.0.0.1:${REDIS_PORT:-6379}:6379');
    });
  });
});
