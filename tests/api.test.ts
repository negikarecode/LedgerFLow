import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/api/app';
import * as poolModule from '../src/db/pool';
import * as redisModule from '../src/redis/client';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const DEMO_AUTH = `Bearer ${DEMO_KEY}`;
const DEMO_KEY_HASH = 'c493db595f469fe025715057076dd17b8c4c8b80f596988553641df7d04a33be';
const DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

function mockApiKeyQuery(sql: string) {
  if (sql.includes('FROM api_keys')) {
    return {
      rows: [
        {
          id: 'k0000000-0000-0000-0000-000000000001',
          key_hash: DEMO_KEY_HASH,
          merchant_id: DEMO_MERCHANT_ID,
          merchant_name: 'Default Demo Merchant',
          revoked_at: null,
        },
      ],
    };
  }
  if (sql.includes('UPDATE api_keys')) {
    return { rows: [] };
  }
  return null;
}

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

    it('GET /health/live should return 200 OK even if Redis or PostgreSQL is down (liveness)', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.uptime_seconds).toBeDefined();

      const aliasRes = await request(app).get('/livez');
      expect(aliasRes.status).toBe(200);
      expect(aliasRes.body.status).toBe('ok');
    });

    it('GET /health/ready should return 200 degraded when Redis is DOWN but PostgreSQL is UP (readiness)', async () => {
      vi.spyOn(poolModule, 'checkDbHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 1,
      });
      vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
        status: 'down',
        latencyMs: 10,
        error: 'Connection is closed.',
      });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(true);
      expect(res.body.degraded).toBe(true);
      expect(res.body.status).toBe('degraded');
      expect(res.body.services.postgres.status).toBe('up');
      expect(res.body.services.redis.status).toBe('down');

      const aliasRes = await request(app).get('/readyz');
      expect(aliasRes.status).toBe(200);
      expect(aliasRes.body.ready).toBe(true);
    });

    it('GET /health/ready should return 503 when required PostgreSQL is DOWN', async () => {
      vi.spyOn(poolModule, 'checkDbHealth').mockResolvedValue({
        status: 'down',
        latencyMs: 5,
        error: 'Postgres connection pool exhausted',
      });
      vi.spyOn(redisModule, 'checkRedisHealth').mockResolvedValue({
        status: 'up',
        latencyMs: 1,
      });

      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.ready).toBe(false);
      expect(res.body.status).toBe('down');
      expect(res.body.services.postgres.status).toBe('down');
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
      expect(res.body.paths['/transfers']).toBeDefined();
      expect(res.body.paths['/accounts/{id}/ledger']).toBeDefined();
      expect(res.body.paths['/outbox']).toBeDefined();
    });
  });

  describe('POST /accounts', () => {
    it('should reject requests with missing owner_name', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', DEMO_AUTH)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details[0].field).toBe('owner_name');
    });

    it('should reject requests with negative initial_credit_paise', async () => {
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', DEMO_AUTH)
        .send({
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

      const res = await request(app)
        .post('/accounts')
        .set('Authorization', DEMO_AUTH)
        .send({
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
        const keyMock = mockApiKeyQuery(sql);
        if (keyMock) return Promise.resolve(keyMock as any);

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

      const res = await request(app)
        .get('/accounts')
        .set('Authorization', DEMO_AUTH);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].balance_paise).toBe(25000);
      expect(res.body.pagination.total).toBe(1);
    });
  });

  describe('GET /accounts/:id/ledger', () => {
    it('should return 404 when account does not exist', async () => {
      vi.spyOn(poolModule, 'query').mockImplementation((sql: string) => {
        const keyMock = mockApiKeyQuery(sql);
        if (keyMock) return Promise.resolve(keyMock as any);
        return Promise.resolve({ rows: [] } as any);
      });

      const res = await request(app)
        .get('/accounts/a0000000-0000-0000-0000-000000000099/ledger')
        .set('Authorization', DEMO_AUTH);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });

    it('should return chronological ledger entries and balance for valid account', async () => {
      vi.spyOn(poolModule, 'query').mockImplementation((sql: string) => {
        const keyMock = mockApiKeyQuery(sql);
        if (keyMock) return Promise.resolve(keyMock as any);

        if (sql.includes('FROM accounts') && sql.includes('WHERE id = $1')) {
          return Promise.resolve({
            rows: [
              {
                id: 'a0000000-0000-0000-0000-000000000001',
                owner_name: 'Ledger Alice',
                currency: 'INR',
                created_at: new Date().toISOString(),
              },
            ],
          } as any);
        }
        if (sql.includes('AS balance_paise')) {
          return Promise.resolve({ rows: [{ balance_paise: '75000' }] } as any);
        }
        if (sql.includes('ORDER BY created_at ASC')) {
          return Promise.resolve({
            rows: [
              {
                id: 'e0000000-0000-0000-0000-000000000001',
                transaction_id: 't0000000-0000-0000-0000-000000000001',
                account_id: 'a0000000-0000-0000-0000-000000000001',
                entry_type: 'CREDIT',
                amount: '100000',
                created_at: new Date().toISOString(),
              },
              {
                id: 'e0000000-0000-0000-0000-000000000002',
                transaction_id: 't0000000-0000-0000-0000-000000000002',
                account_id: 'a0000000-0000-0000-0000-000000000001',
                entry_type: 'DEBIT',
                amount: '25000',
                created_at: new Date().toISOString(),
              },
            ],
          } as any);
        }
        return Promise.resolve({ rows: [] } as any);
      });

      const res = await request(app)
        .get('/accounts/a0000000-0000-0000-0000-000000000001/ledger')
        .set('Authorization', DEMO_AUTH);
      expect(res.status).toBe(200);
      expect(res.body.account_id).toBe('a0000000-0000-0000-0000-000000000001');
      expect(res.body.balance_paise).toBe(75000);
      expect(res.body.ledger_entries).toHaveLength(2);
      expect(res.body.ledger_entries[0].amount).toBe(100000);
      expect(res.body.ledger_entries[1].amount).toBe(25000);
    });
  });

  describe('GET /outbox', () => {
    it('should list outbox events with pagination metadata', async () => {
      vi.spyOn(poolModule, 'query').mockImplementation((sql: string) => {
        const keyMock = mockApiKeyQuery(sql);
        if (keyMock) return Promise.resolve(keyMock as any);

        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ total: 1 }] } as any);
        }
        return Promise.resolve({
          rows: [
            {
              id: 'o0000000-0000-0000-0000-000000000001',
              event_type: 'transfer.completed',
              payload: { test: true },
              target_url: 'https://example.com/webhook',
              status: 'PENDING',
              attempts: 0,
              next_retry_at: null,
              created_at: new Date().toISOString(),
            },
          ],
        } as any);
      });

      const res = await request(app)
        .get('/outbox')
        .set('Authorization', DEMO_AUTH);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('PENDING');
      expect(res.body.pagination.total).toBe(1);
    });
  });
});
