import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, query, closePool } from '../src/db/pool';
import { redis, closeRedis } from '../src/redis/client';
import { env } from '../src/config/env';

describe('LedgerFlow Authentication & Multi-Tenancy Suite', () => {
  const adminToken = env.ADMIN_TOKEN;
  let merchantA: { id: string; name: string; key: string; keyId: string };
  let merchantB: { id: string; name: string; key: string; keyId: string };

  beforeAll(async () => {
    // 1. Bootstrap Merchant A via Admin API
    const resA = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Tenant A ${Date.now()}` });

    expect(resA.status).toBe(201);
    expect(resA.body.merchant.id).toBeDefined();
    expect(resA.body.api_key.key).toMatch(/^lf_live_/);

    merchantA = {
      id: resA.body.merchant.id,
      name: resA.body.merchant.name,
      key: resA.body.api_key.key,
      keyId: resA.body.api_key.id,
    };

    // 2. Bootstrap Merchant B via Admin API
    const resB = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Tenant B ${Date.now()}` });

    expect(resB.status).toBe(201);
    merchantB = {
      id: resB.body.merchant.id,
      name: resB.body.merchant.name,
      key: resB.body.api_key.key,
      keyId: resB.body.api_key.id,
    };
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('Admin Bootstrap Authentication (ADMIN_TOKEN)', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app)
        .post('/admin/merchants')
        .send({ name: 'Unauthorized Merchant' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toContain('Missing or invalid Authorization header');
    });

    it('should return 401 when admin token is incorrect', async () => {
      const res = await request(app)
        .post('/admin/merchants')
        .set('Authorization', 'Bearer wrong-secret-token')
        .send({ name: 'Unauthorized Merchant' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toBe('Invalid admin authorization token');
    });

    it('should successfully create an additional API key for existing merchant', async () => {
      const res = await request(app)
        .post(`/admin/merchants/${merchantA.id}/keys`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(201);
      expect(res.body.merchant_id).toBe(merchantA.id);
      expect(res.body.api_key.key).toMatch(/^lf_live_/);
      expect(res.body.api_key.key_prefix).toBeDefined();
    });
  });

  describe('Merchant API Key Authentication (requireApiKey)', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('should return 401 when API key does not start with lf_live_', async () => {
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', 'Bearer invalid_prefix_key_123');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toContain('Expected lf_live_<token>');
    });

    it('should return 401 when API key has valid prefix format but does not exist in DB', async () => {
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', 'Bearer lf_live_non_existent_key_random_bytes_99999');

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toBe('Invalid or revoked API key');
    });

    it('should return 401 when API key has been revoked', async () => {
      // 1. Create a key specifically to revoke
      const keyRes = await request(app)
        .post(`/admin/merchants/${merchantA.id}/keys`)
        .set('Authorization', `Bearer ${adminToken}`);
      const disposableKey = keyRes.body.api_key.key;
      const disposableKeyId = keyRes.body.api_key.id;

      // 2. Verify key works before revocation
      const workingRes = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${disposableKey}`);
      expect(workingRes.status).toBe(200);

      // 3. Revoke the key
      const revokeRes = await request(app)
        .post(`/admin/keys/${disposableKeyId}/revoke`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revokeRes.status).toBe(200);

      // 4. Verify request with revoked key fails with 401
      const failedRes = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${disposableKey}`);
      expect(failedRes.status).toBe(401);
      expect(failedRes.body.error).toBe('Unauthorized');
      expect(failedRes.body.message).toBe('API key has been revoked');
    });
  });

  describe('Multi-Tenancy Cross-Tenant Resource Isolation', () => {
    let accountA1: any;
    let accountA2: any;
    let accountB1: any;
    let transferAEventId: string;

    beforeAll(async () => {
      // Create accounts under Merchant A
      const accA1Res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .send({ owner_name: 'Merchant A Wallet 1', currency: 'INR', initial_credit_paise: 50000 });
      accountA1 = accA1Res.body;

      const accA2Res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .send({ owner_name: 'Merchant A Wallet 2', currency: 'INR', initial_credit_paise: 10000 });
      accountA2 = accA2Res.body;

      // Create account under Merchant B
      const accB1Res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .send({ owner_name: 'Merchant B Wallet 1', currency: 'INR', initial_credit_paise: 30000 });
      accountB1 = accB1Res.body;

      // Register an active webhook endpoint for Merchant A
      await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .send({ url: 'https://example.com/merchant-a-webhooks' });

      // Perform a transfer within Merchant A to create an outbox event
      const transferRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .set('Idempotency-Key', `tx-tenant-a-${uuidv4()}`)
        .send({
          from_account_id: accountA1.id,
          to_account_id: accountA2.id,
          amount_paise: 5000,
        });
      transferAEventId = transferRes.body.outbox_event_id;
    });

    it('Account Listing: Merchant B cannot see Merchant A accounts in GET /accounts', async () => {
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${merchantB.key}`);

      expect(res.status).toBe(200);
      const ids = res.body.data.map((acc: any) => acc.id);
      expect(ids).toContain(accountB1.id);
      expect(ids).not.toContain(accountA1.id);
      expect(ids).not.toContain(accountA2.id);
    });

    it('Account Details: Merchant B querying Merchant A account returns 404 (not 403)', async () => {
      const res = await request(app)
        .get(`/accounts/${accountA1.id}`)
        .set('Authorization', `Bearer ${merchantB.key}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });

    it('Account Ledger: Merchant B reading Merchant A ledger history returns 404 (not 403)', async () => {
      const res = await request(app)
        .get(`/accounts/${accountA1.id}/ledger`)
        .set('Authorization', `Bearer ${merchantB.key}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });

    it('Transfers: Merchant B cannot debit Merchant A account (returns 404, not 403)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .set('Idempotency-Key', `transfer-cross-attempt-${uuidv4()}`)
        .send({
          from_account_id: accountA1.id, // Foreign account!
          to_account_id: accountB1.id,
          amount_paise: 1000,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body.message).toContain('One or both accounts not found');
    });

    it('Transfers: Merchant B cannot credit Merchant A account (returns 404, not 403)', async () => {
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .set('Idempotency-Key', `transfer-cross-attempt-2-${uuidv4()}`)
        .send({
          from_account_id: accountB1.id,
          to_account_id: accountA1.id, // Foreign account!
          amount_paise: 1000,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body.message).toContain('One or both accounts not found');
    });

    it('Outbox Listing: Merchant B cannot see Merchant A outbox events in GET /outbox', async () => {
      const res = await request(app)
        .get('/outbox')
        .set('Authorization', `Bearer ${merchantB.key}`);

      expect(res.status).toBe(200);
      const eventIds = res.body.data.map((e: any) => e.id);
      expect(eventIds).not.toContain(transferAEventId);
    });

    it('Outbox Replay: Merchant B cannot replay Merchant A outbox event (returns 404, not 403)', async () => {
      const res = await request(app)
        .post(`/outbox/${transferAEventId}/replay`)
        .set('Authorization', `Bearer ${merchantB.key}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });
  });

  describe('Namespaced Idempotency Keys across Tenants', () => {
    it('allows Merchant A and Merchant B to execute transfers using the IDENTICAL Idempotency-Key without collision', async () => {
      // 1. Create test accounts for both merchants
      const accA1 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .send({ owner_name: 'Idemp Tenant A1', currency: 'INR', initial_credit_paise: 100000 });

      const accA2 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .send({ owner_name: 'Idemp Tenant A2', currency: 'INR', initial_credit_paise: 10000 });

      const accB1 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .send({ owner_name: 'Idemp Tenant B1', currency: 'INR', initial_credit_paise: 100000 });

      const accB2 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .send({ owner_name: 'Idemp Tenant B2', currency: 'INR', initial_credit_paise: 10000 });

      // Shared identical idempotency key string
      const sharedKey = `shared-idemp-collision-test-${uuidv4()}`;

      // 2. Merchant A executes transfer with sharedKey
      const resA = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accA1.body.id,
          to_account_id: accA2.body.id,
          amount_paise: 10000,
        });

      expect(resA.status).toBe(201);
      expect(resA.body.status).toBe('COMPLETED');
      expect(resA.headers['x-idempotent-replay']).toBeUndefined();

      // 3. Merchant B executes transfer with the EXACT SAME sharedKey
      const resB = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accB1.body.id,
          to_account_id: accB2.body.id,
          amount_paise: 15000,
        });

      // Must NOT collide or return 409 or replay Merchant A's transfer!
      expect(resB.status).toBe(201);
      expect(resB.body.status).toBe('COMPLETED');
      expect(resB.headers['x-idempotent-replay']).toBeUndefined();
      expect(resB.body.transaction_id).not.toBe(resA.body.transaction_id);
      expect(resB.body.amount_paise).toBe(15000);

      // 4. Replay with Merchant A's key should replay Merchant A's transfer
      const replayA = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantA.key}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accA1.body.id,
          to_account_id: accA2.body.id,
          amount_paise: 10000,
        });

      expect(replayA.status).toBe(201);
      expect(replayA.headers['x-idempotent-replay']).toBe('true');
      expect(replayA.body.transaction_id).toBe(resA.body.transaction_id);

      // 5. Replay with Merchant B's key should replay Merchant B's transfer
      const replayB = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantB.key}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accB1.body.id,
          to_account_id: accB2.body.id,
          amount_paise: 15000,
        });

      expect(replayB.status).toBe(201);
      expect(replayB.headers['x-idempotent-replay']).toBe('true');
      expect(replayB.body.transaction_id).toBe(resB.body.transaction_id);
    });
  });

  describe('Demo Mode & Metrics Protection Gating', () => {
    it('blocks demo routes with 403 when DEMO_MODE is disabled in non-test environment', async () => {
      const origFlag = process.env.TEST_BLOCK_DEMO;
      const origDemo = process.env.DEMO_MODE;
      try {
        process.env.TEST_BLOCK_DEMO = 'true';
        process.env.DEMO_MODE = 'false';
        (env as any).DEMO_MODE = false;
        const res = await request(app).post('/demo/reset');
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('DEMO_MODE_DISABLED');
      } finally {
        if (origFlag !== undefined) process.env.TEST_BLOCK_DEMO = origFlag;
        else delete process.env.TEST_BLOCK_DEMO;
        if (origDemo !== undefined) process.env.DEMO_MODE = origDemo;
        else delete process.env.DEMO_MODE;
        (env as any).DEMO_MODE = true;
      }
    });

    it('enforces METRICS_TOKEN if configured in environment', async () => {
      const origToken = process.env.METRICS_TOKEN;
      try {
        process.env.METRICS_TOKEN = 'secret-metrics-token-123';
        
        // 1. Without token: 401
        const resUnauth = await request(app).get('/metrics');
        expect(resUnauth.status).toBe(401);
        expect(resUnauth.body.error).toBe('UNAUTHORIZED');

        // 2. With invalid token: 401
        const resBad = await request(app)
          .get('/metrics')
          .set('Authorization', 'Bearer wrong-token');
        expect(resBad.status).toBe(401);

        // 3. With valid token in Bearer header: 200
        const resGood = await request(app)
          .get('/metrics')
          .set('Authorization', 'Bearer secret-metrics-token-123');
        expect(resGood.status).toBe(200);
        expect(resGood.text).toContain('ledgerflow_');

        // 4. With valid token in query param: 200
        const resQuery = await request(app)
          .get('/metrics?token=secret-metrics-token-123');
        expect(resQuery.status).toBe(200);
      } finally {
        if (origToken !== undefined) {
          process.env.METRICS_TOKEN = origToken;
        } else {
          delete process.env.METRICS_TOKEN;
        }
      }
    });
  });
});
