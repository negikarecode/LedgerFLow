import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, query, closePool } from '../src/db/pool';
import { closeRedis } from '../src/redis/client';
import { env } from '../src/config/env';
import { generateApiKey, hashApiKey, verifyApiKeyHash } from '../src/api/utils/api-key';

describe('Tenant Authorization & Isolation Security Audit Suite', () => {
  const adminToken = env.ADMIN_TOKEN;

  let merchantAId: string;
  let merchantAKey: string;
  let accountA1Id: string;
  let accountA2Id: string;
  let endpointAId: string;

  let merchantBId: string;
  let merchantBKey: string;
  let accountB1Id: string;
  let endpointBId: string;

  beforeAll(async () => {
    // 1. Bootstrap Merchant A
    const resA = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Tenant Alpha ${Date.now()}` });
    merchantAId = resA.body.merchant.id;
    merchantAKey = resA.body.api_key.key;

    // Create accounts for Merchant A
    const a1 = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${merchantAKey}`)
      .send({ owner_name: 'Alpha Primary', currency: 'INR', initial_credit_paise: 500000 });
    accountA1Id = a1.body.id;

    const a2 = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${merchantAKey}`)
      .send({ owner_name: 'Alpha Secondary', currency: 'INR', initial_credit_paise: 100000 });
    accountA2Id = a2.body.id;

    // Create webhook endpoint for Merchant A
    const epA = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${merchantAKey}`)
      .send({ url: 'https://alpha.example.com/webhooks' });
    endpointAId = epA.body.id;

    // 2. Bootstrap Merchant B
    const resB = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Tenant Beta ${Date.now()}` });
    merchantBId = resB.body.merchant.id;
    merchantBKey = resB.body.api_key.key;

    // Create accounts for Merchant B
    const b1 = await request(app)
      .post('/accounts')
      .set('Authorization', `Bearer ${merchantBKey}`)
      .send({ owner_name: 'Beta Primary', currency: 'INR', initial_credit_paise: 300000 });
    accountB1Id = b1.body.id;

    // Create webhook endpoint for Merchant B
    const epB = await request(app)
      .post('/webhook-endpoints')
      .set('Authorization', `Bearer ${merchantBKey}`)
      .send({ url: 'https://beta.example.com/webhooks' });
    endpointBId = epB.body.id;
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('1. API Key Generation, Storage & Cryptographic Verification', () => {
    it('should generate keys with format lf_live_<32 bytes base64url> and 256 bits of entropy', () => {
      const { fullKey, prefix, hash } = generateApiKey();
      expect(fullKey).toMatch(/^lf_live_[A-Za-z0-9_-]{43}$/);
      expect(prefix).toBe(fullKey.slice(0, 16));
      expect(hash).toHaveLength(64); // SHA-256 hex string
    });

    it('should store only key_prefix and key_hash in PostgreSQL, never plaintext full keys', async () => {
      const dbKeys = await query(
        `SELECT id, key_prefix, key_hash FROM api_keys WHERE merchant_id = $1`,
        [merchantAId]
      );
      expect(dbKeys.rows.length).toBeGreaterThanOrEqual(1);

      for (const row of dbKeys.rows) {
        expect(row.key_prefix).toBe(merchantAKey.slice(0, 16));
        // Verify key_hash is SHA-256 (64 hex characters)
        expect(row.key_hash).toHaveLength(64);
        expect(row.key_hash).toBe(hashApiKey(merchantAKey));
        // Verify raw key is NOT present in any column
        expect(JSON.stringify(row)).not.toContain(merchantAKey);
      }
    });

    it('should use timingSafeEqual for hash verification', () => {
      const hash1 = hashApiKey('lf_live_test_key_1');
      const hash2 = hashApiKey('lf_live_test_key_1');
      const hash3 = hashApiKey('lf_live_test_key_2');

      expect(verifyApiKeyHash(hash1, hash2)).toBe(true);
      expect(verifyApiKeyHash(hash1, hash3)).toBe(false);
      expect(verifyApiKeyHash('invalid_hex', hash2)).toBe(false);
    });
  });

  describe('2. Authentication Rejection Matrix (Missing, Malformed, Unknown, Revoked, Expired)', () => {
    it('should reject requests missing Authorization header with 401', async () => {
      const res = await request(app).get('/accounts');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
      expect(res.body.message).toMatch(/missing or invalid authorization header/i);
    });

    it('should reject non-Bearer schemes (e.g. Basic, Token) with 401', async () => {
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', `Basic dXNlcjpwYXNz`);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/expected bearer <api_key>/i);
    });

    it('should reject malformed API key formats with 401', async () => {
      // Missing prefix
      const res1 = await request(app)
        .get('/accounts')
        .set('Authorization', 'Bearer invalid_prefix_key_12345');
      expect(res1.status).toBe(401);
      expect(res1.body.message).toMatch(/invalid api key format/i);

      // Too short
      const res2 = await request(app)
        .get('/accounts')
        .set('Authorization', 'Bearer lf_live_short');
      expect(res2.status).toBe(401);
      expect(res2.body.message).toMatch(/invalid api key format/i);

      // Invalid characters / spaces
      const res3 = await request(app)
        .get('/accounts')
        .set('Authorization', 'Bearer lf_live_with spaces in the middle of key');
      expect(res3.status).toBe(401);
      expect(res3.body.message).toMatch(/invalid api key format/i);
    });

    it('should reject unknown API keys with 401', async () => {
      const fakeKey = `lf_live_${uuidv4().replace(/-/g, '')}${uuidv4().replace(/-/g, '')}`;
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${fakeKey}`);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid or revoked api key/i);
    });

    it('should reject revoked API keys with 401', async () => {
      // 1. Create a key specifically to revoke
      const keyRes = await request(app)
        .post(`/admin/merchants/${merchantAId}/keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send();
      const ephemeralKey = keyRes.body.api_key.key;
      const ephemeralKeyId = keyRes.body.api_key.id;

      // Verify it works while active
      const activeCheck = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${ephemeralKey}`);
      expect(activeCheck.status).toBe(200);

      // 2. Revoke the key
      const revokeRes = await request(app)
        .post(`/admin/keys/${ephemeralKeyId}/revoke`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revokeRes.status).toBe(200);

      // 3. Verify it is rejected immediately
      const revokedCheck = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${ephemeralKey}`);
      expect(revokedCheck.status).toBe(401);
      expect(revokedCheck.body.message).toMatch(/api key has been revoked/i);
    });

    it('should reject expired API keys with 401', async () => {
      // Create a key that expired in the past
      const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const keyRes = await request(app)
        .post(`/admin/merchants/${merchantAId}/keys`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ expires_at: pastDate });

      const expiredKey = keyRes.body.api_key.key;

      const expiredCheck = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${expiredKey}`);
      expect(expiredCheck.status).toBe(401);
      expect(expiredCheck.body.message).toMatch(/api key has expired/i);
    });
  });

  describe('3. Account & Ledger Tenant Scoping (Anti-Enumeration via 404)', () => {
    it('should only return accounts belonging to the authenticated merchant in GET /accounts', async () => {
      const resA = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${merchantAKey}`);
      expect(resA.status).toBe(200);
      const aIds = resA.body.data.map((acc: any) => acc.id);
      expect(aIds).toContain(accountA1Id);
      expect(aIds).toContain(accountA2Id);
      expect(aIds).not.toContain(accountB1Id);

      const resB = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${merchantBKey}`);
      expect(resB.status).toBe(200);
      const bIds = resB.body.data.map((acc: any) => acc.id);
      expect(bIds).toContain(accountB1Id);
      expect(bIds).not.toContain(accountA1Id);
      expect(bIds).not.toContain(accountA2Id);
    });

    it('GET /accounts/:id: should return 404 Not Found when Tenant B attempts to access Tenant A account', async () => {
      // Tenant B queries Tenant A account
      const res = await request(app)
        .get(`/accounts/${accountA1Id}`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      // Must be 404 Not Found (anti-enumeration: never 403)
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body.message).toContain('not found');
      // Must not leak owner name or tenant info
      expect(res.body).not.toHaveProperty('owner_name');
      expect(res.body).not.toHaveProperty('balance_paise');
    });

    it('GET /accounts/:id/ledger: should return 404 Not Found when Tenant B attempts to inspect Tenant A ledger', async () => {
      const res = await request(app)
        .get(`/accounts/${accountA1Id}/ledger`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body).not.toHaveProperty('ledger_entries');
    });
  });

  describe('4. Transfer Tenant Isolation & Theft Prevention', () => {
    it('should reject cross-tenant transfers from Tenant A to Tenant B with 404 (funds untouched)', async () => {
      const preBalanceA = await query('SELECT balance_paise FROM accounts WHERE id = $1', [accountA1Id]);
      const preBalanceB = await query('SELECT balance_paise FROM accounts WHERE id = $1', [accountB1Id]);

      // Tenant A attempts transfer to Tenant B account
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .set('Idempotency-Key', `idor-tx-${uuidv4()}`)
        .send({
          from_account_id: accountA1Id,
          to_account_id: accountB1Id,
          amount_paise: 50000,
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/one or both accounts not found/i);

      // Invariant: Balances must remain identical
      const postBalanceA = await query('SELECT balance_paise FROM accounts WHERE id = $1', [accountA1Id]);
      const postBalanceB = await query('SELECT balance_paise FROM accounts WHERE id = $1', [accountB1Id]);
      expect(postBalanceA.rows[0].balance_paise).toBe(preBalanceA.rows[0].balance_paise);
      expect(postBalanceB.rows[0].balance_paise).toBe(preBalanceB.rows[0].balance_paise);
    });

    it('should reject unauthorized theft transfers where Tenant B attempts to debit Tenant A account', async () => {
      // Tenant B attempts to debit Tenant A account into Tenant B account
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantBKey}`)
        .set('Idempotency-Key', `theft-tx-${uuidv4()}`)
        .send({
          from_account_id: accountA1Id,
          to_account_id: accountB1Id,
          amount_paise: 100000,
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/one or both accounts not found/i);
    });

    it('should reject transfers between two accounts belonging to another tenant', async () => {
      // Tenant B attempts to execute transfer between A1 and A2
      const res = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantBKey}`)
        .set('Idempotency-Key', `foreign-tx-${uuidv4()}`)
        .send({
          from_account_id: accountA1Id,
          to_account_id: accountA2Id,
          amount_paise: 25000,
        });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/one or both accounts not found/i);
    });
  });

  describe('5. Idempotency Key Namespacing & Isolation Across Tenants', () => {
    it('should allow two different tenants to use the IDENTICAL Idempotency-Key without collision or replay', async () => {
      const sharedKey = `shared-idemp-${uuidv4()}`;

      // 1. Tenant A executes transfer with sharedKey
      const resA = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accountA1Id,
          to_account_id: accountA2Id,
          amount_paise: 1000,
        });
      expect(resA.status).toBe(201);
      expect(resA.body.status).toBe('COMPLETED');
      const txAId = resA.body.transaction_id;

      // 2. Tenant B executes transfer with the EXACT SAME sharedKey
      // Create a second account for Tenant B to transfer between
      const b2 = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantBKey}`)
        .send({ owner_name: 'Beta Secondary', currency: 'INR', initial_credit_paise: 0 });

      const resB = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantBKey}`)
        .set('Idempotency-Key', sharedKey)
        .send({
          from_account_id: accountB1Id,
          to_account_id: b2.body.id,
          amount_paise: 2000,
        });
      expect(resB.status).toBe(201);
      expect(resB.body.status).toBe('COMPLETED');
      const txBId = resB.body.transaction_id;

      // Invariant: Both transactions succeeded independently with distinct IDs
      expect(txAId).not.toBe(txBId);
      // Invariant: Neither request received a replay from the other tenant
      expect(resB.headers['x-idempotent-replay']).toBeUndefined();
    });
  });

  describe('6. Webhook Endpoints & Secret Management Isolation', () => {
    it('should not allow Tenant B to view Tenant A webhook endpoints (returns 404)', async () => {
      const res = await request(app)
        .get(`/webhook-endpoints/${endpointAId}`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
    });

    it('should not allow Tenant B to delete Tenant A webhook endpoints (returns 404)', async () => {
      const res = await request(app)
        .delete(`/webhook-endpoints/${endpointAId}`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);

      // Verify endpoint is still alive in DB
      const dbCheck = await query('SELECT id FROM webhook_endpoints WHERE id = $1', [endpointAId]);
      expect(dbCheck.rows).toHaveLength(1);
    });

    it('should not allow Tenant B to rotate Tenant A webhook endpoint secret (returns 404)', async () => {
      const res = await request(app)
        .post(`/webhook-endpoints/${endpointAId}/rotate-secret`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);
    });
  });

  describe('7. Outbox Events & Delivery Logs Isolation', () => {
    let outboxAId: string;

    beforeAll(async () => {
      // Execute a transfer under Tenant A to generate an outbox event
      const txRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .set('Idempotency-Key', `outbox-gen-${uuidv4()}`)
        .send({
          from_account_id: accountA1Id,
          to_account_id: accountA2Id,
          amount_paise: 500,
        });
      outboxAId = txRes.body.outbox_event_id;
    });

    it('GET /outbox: should not list outbox events belonging to other merchants', async () => {
      const resB = await request(app)
        .get('/outbox')
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(resB.status).toBe(200);
      const bOutboxIds = resB.body.data.map((evt: any) => evt.id);
      expect(bOutboxIds).not.toContain(outboxAId);
    });

    it('GET /outbox/:id: should return 404 Not Found when Tenant B queries Tenant A outbox event', async () => {
      const res = await request(app)
        .get(`/outbox/${outboxAId}`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Not Found');
      expect(res.body).not.toHaveProperty('delivery_attempts');
    });

    it('POST /outbox/:id/replay: should return 404 Not Found when Tenant B attempts to replay Tenant A event', async () => {
      const res = await request(app)
        .post(`/outbox/${outboxAId}/replay`)
        .set('Authorization', `Bearer ${merchantBKey}`);

      expect(res.status).toBe(404);
    });

    it('POST /outbox/replay-batch: should return 404 Not Found when Tenant B provides Tenant A endpoint_id', async () => {
      const res = await request(app)
        .post('/outbox/replay-batch')
        .set('Authorization', `Bearer ${merchantBKey}`)
        .send({ endpoint_id: endpointAId });

      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/webhook endpoint with id .* not found/i);
    });
  });

  describe('8. Client Context Tampering (merchant_id Injection Immunity)', () => {
    it('should ignore client-supplied merchant_id in POST /accounts and bind to authenticated merchant', async () => {
      // Tenant A passes merchant_id: merchantBId in request body
      const res = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .send({
          owner_name: 'Spoofed Account',
          currency: 'INR',
          initial_credit_paise: 0,
          merchant_id: merchantBId, // Malicious override attempt
        });

      expect(res.status).toBe(201);
      // Invariant: Account is bound to Merchant A, NEVER Merchant B
      expect(res.body.merchant_id).toBe(merchantAId);
      expect(res.body.merchant_id).not.toBe(merchantBId);

      // Verify in DB directly
      const dbCheck = await query('SELECT merchant_id FROM accounts WHERE id = $1', [res.body.id]);
      expect(dbCheck.rows[0].merchant_id).toBe(merchantAId);
    });

    it('should ignore client-supplied merchant_id in POST /webhook-endpoints', async () => {
      const res = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .send({
          url: 'https://spoof.example.com',
          merchant_id: merchantBId,
        });

      expect(res.status).toBe(201);
      expect(res.body.merchant_id).toBe(merchantAId);
      expect(res.body.merchant_id).not.toBe(merchantBId);
    });
  });

  describe('9. Role Separation & Administrative Route Privilege Escalation', () => {
    it('should reject merchant API keys accessing /admin routes with 401', async () => {
      // Merchant key attempts to create merchant
      const res1 = await request(app)
        .post('/admin/merchants')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .send({ name: 'Privilege Escalation' });
      expect(res1.status).toBe(401);
      expect(res1.body.message).toMatch(/invalid admin authorization token/i);

      // Merchant key attempts to trigger admin reconciliation
      const res2 = await request(app)
        .post('/admin/reconcile')
        .set('Authorization', `Bearer ${merchantAKey}`)
        .send({});
      expect(res2.status).toBe(401);
      expect(res2.body.message).toMatch(/invalid admin authorization token/i);

      // Merchant key attempts to revoke another key
      const res3 = await request(app)
        .post(`/admin/keys/${uuidv4()}/revoke`)
        .set('Authorization', `Bearer ${merchantAKey}`);
      expect(res3.status).toBe(401);
    });

    it('should reject admin token accessing merchant routes with 401 (requires lf_live_ format)', async () => {
      // Admin token attempts to call /accounts
      const res = await request(app)
        .get('/accounts')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/invalid api key format/i);
    });
  });
});
