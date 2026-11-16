import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/api/app';
import * as poolModule from '../src/db/pool';
import * as redisModule from '../src/redis/client';

describe('LedgerFlow API Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /health', () => {
    it('should return 200 OK when both PostgreSQL and Redis are UP', async () => {
      vi.spyOn(poolModule, 'checkDbHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 1,
      });
      vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 1,
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.services.postgres.status).toBe('up');
      expect(res.body.services.redis.status).toBe('up');
      expect(res.body.timestamp).toBeDefined();
    });

    it('should return 503 Service Unavailable when PostgreSQL is DOWN', async () => {
      vi.spyOn(poolModule, 'checkDbHealth').mockResolvedValue({
        status: 'down',
        latencyMs: 5,
        error: 'connection refused',
      });
      vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 1,
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.services.postgres.status).toBe('down');
      expect(res.body.services.redis.status).toBe('up');
    });

    it('should return 503 Service Unavailable when Redis is DOWN', async () => {
      vi.spyOn(poolModule, 'checkDbHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 2,
      });
      vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
        status: 'down',
        latencyMs: 5,
        error: 'Redis connection timed out',
      });

      const res = await request(app).get('/health');

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.services.postgres.status).toBe('up');
      expect(res.body.services.redis.status).toBe('down');
    });
  });

  describe('GET /docs', () => {
    it('should serve Swagger UI at /docs', async () => {
      const res = await request(app).get('/docs/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Swagger UI');
    });

    it('should serve OpenAPI JSON specification at /docs.json', async () => {
      const res = await request(app).get('/docs.json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.0.0');
      expect(res.body.info.title).toBe('LedgerFlow API');
      expect(res.body.paths['/health']).toBeDefined();
      expect(res.body.paths['/accounts']).toBeDefined();
    });
  });

  describe('POST /accounts', () => {
    it('should reject requests with missing owner_name', async () => {
      const res = await request(app).post('/accounts').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('owner_name');
    });

    it('should reject requests with negative initial_credit_paise', async () => {
      const res = await request(app).post('/accounts').send({
        owner_name: 'Test User',
        initial_credit_paise: -500,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('should successfully create an account with seed credit', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
            return Promise.resolve();
          }
          if (sql.includes('INSERT INTO accounts')) {
            return Promise.resolve({
              rows: [
                {
                  id: 'a0000000-0000-0000-0000-000000000001',
                  owner_name: 'Bob Sharma',
                  currency: 'INR',
                  created_at: new Date().toISOString(),
                },
              ],
            });
          }
          if (sql.includes('INSERT INTO ledger_entries')) {
            return Promise.resolve({
              rows: [
                {
                  id: 'e0000000-0000-0000-0000-000000000001',
                  transaction_id: 't0000000-0000-0000-0000-000000000001',
                  entry_type: 'CREDIT',
                  amount: 10000,
                  created_at: new Date().toISOString(),
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn(),
      };

      vi.spyOn(poolModule, 'getClient').mockResolvedValue(mockClient as any);

      const res = await request(app).post('/accounts').send({
        owner_name: 'Bob Sharma',
        currency: 'INR',
        initial_credit_paise: 10000,
      });

      expect(res.status).toBe(201);
      expect(res.body.owner_name).toBe('Bob Sharma');
      expect(res.body.balance_paise).toBe(10000);
      expect(res.body.initial_transaction_id).toBeDefined();
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('GET /accounts', () => {
    it('should list accounts with calculated balances', async () => {
      vi.spyOn(poolModule, 'query').mockImplementation((sql: string) => {
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ total: 1 }] } as any);
        }
        return Promise.resolve({
          rows: [
            {
              id: 'a0000000-0000-0000-0000-000000000001',
              owner_name: 'Alice',
              currency: 'INR',
              created_at: new Date().toISOString(),
              balance_paise: '25000',
            },
          ],
        } as any);
      });

      const res = await request(app).get('/accounts');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].balance_paise).toBe(25000);
      expect(res.body.pagination.total).toBe(1);
    });
  });
});
