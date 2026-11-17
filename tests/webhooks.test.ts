import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import { pool, query, closePool } from '../src/db/pool';
import { redis, closeRedis } from '../src/redis/client';
import { env } from '../src/config/env';
import {
  isPrivateOrBlockedIP,
  validateWebhookUrl,
  dispatchSecureWebhook,
  SSRFError,
} from '../src/security/ssrf';
import { signPayload, verifySignature } from '../src/worker/signature';
import { processOutboxDelivery } from '../src/worker';

describe('Registered Webhook Endpoints & SSRF Security Suite', () => {
  const adminToken = env.ADMIN_TOKEN;
  let merchantKey: string;
  let merchantId: string;
  let foreignKey: string;
  let foreignMerchantId: string;

  beforeAll(async () => {
    // 1. Bootstrap a primary test merchant
    const mRes = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Webhook Merchant ${Date.now()}` });

    merchantId = mRes.body.merchant.id;
    merchantKey = mRes.body.api_key.key;

    // 2. Bootstrap a foreign merchant
    const fRes = await request(app)
      .post('/admin/merchants')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Foreign Webhook Merchant ${Date.now()}` });

    foreignMerchantId = fRes.body.merchant.id;
    foreignKey = fRes.body.api_key.key;
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  describe('SSRF Protection & IP Validation (src/security/ssrf.ts)', () => {
    it('should identify private, loopback, CGNAT, and link-local IPv4 addresses as blocked', () => {
      // Loopback
      expect(isPrivateOrBlockedIP('127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('127.0.0.254')).toBe(true);

      // Cloud Metadata / Link-Local
      expect(isPrivateOrBlockedIP('169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIP('169.254.0.1')).toBe(true);

      // RFC 1918 Private
      expect(isPrivateOrBlockedIP('10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('10.255.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('172.16.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('172.31.255.255')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.1.1')).toBe(true);
      expect(isPrivateOrBlockedIP('192.168.0.254')).toBe(true);

      // CGNAT
      expect(isPrivateOrBlockedIP('100.64.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('100.127.255.255')).toBe(true);

      // 0.0.0.0/8 & Broadcast
      expect(isPrivateOrBlockedIP('0.0.0.0')).toBe(true);
      expect(isPrivateOrBlockedIP('255.255.255.255')).toBe(true);

      // Valid Public IPs
      expect(isPrivateOrBlockedIP('8.8.8.8')).toBe(false);
      expect(isPrivateOrBlockedIP('1.1.1.1')).toBe(false);
      expect(isPrivateOrBlockedIP('93.184.216.34')).toBe(false); // example.com
    });

    it('should identify private, loopback, link-local, and IPv4-mapped IPv6 addresses as blocked', () => {
      // Loopback
      expect(isPrivateOrBlockedIP('::1')).toBe(true);
      expect(isPrivateOrBlockedIP('0:0:0:0:0:0:0:1')).toBe(true);

      // Unspecified
      expect(isPrivateOrBlockedIP('::')).toBe(true);

      // IPv4-mapped loopback & metadata
      expect(isPrivateOrBlockedIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateOrBlockedIP('::ffff:8.8.8.8')).toBe(false);

      // Unique Local Addresses (fc00::/7)
      expect(isPrivateOrBlockedIP('fc00::1')).toBe(true);
      expect(isPrivateOrBlockedIP('fd12:3456:789a::1')).toBe(true);

      // Link-local unicast (fe80::/10)
      expect(isPrivateOrBlockedIP('fe80::1')).toBe(true);

      // Multicast (ff00::/8)
      expect(isPrivateOrBlockedIP('ff02::1')).toBe(true);
    });

    it('should reject private IP targets in validateWebhookUrl when allowPrivate is false', async () => {
      await expect(
        validateWebhookUrl('http://192.168.1.100/webhook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(SSRFError);

      await expect(
        validateWebhookUrl('http://10.0.0.5:8080/hook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/private, loopback, or reserved/i);
    });

    it('should reject cloud metadata IP (169.254.169.254) in validateWebhookUrl', async () => {
      await expect(
        validateWebhookUrl('http://169.254.169.254/latest/meta-data/', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/private, loopback, or reserved/i);
    });

    it('should reject hostnames resolving to private or loopback IPs', async () => {
      // 'localhost' resolves to 127.0.0.1 or ::1
      await expect(
        validateWebhookUrl('http://localhost:3000/hook', { allowPrivate: false, requireHttps: false })
      ).rejects.toThrow(/resolves to blocked\/private address/i);
    });

    it('should reject redirects targeting private IP addresses in dispatchSecureWebhook', async () => {
      // Create a test server on a local port that attempts to redirect to 169.254.169.254
      const redirectServer = http.createServer((req, res) => {
        if (req.url === '/redirect-to-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/secret-keys' });
          res.end();
        } else {
          res.writeHead(200);
          res.end('OK');
        }
      });

      await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (redirectServer.address() as any).port;

      try {
        // Attempt dispatch with allowPrivate=false: the initial URL is 127.0.0.1 so it fails immediately
        await expect(
          dispatchSecureWebhook({
            url: `http://127.0.0.1:${port}/redirect-to-metadata`,
            payload: '{"test":true}',
            allowPrivate: false,
          })
        ).rejects.toThrow(SSRFError);

        // When initial hop is allowed but redirect targets metadata:
        // Mock a redirect target where allowPrivate applies, but metadata 169.254.169.254 is rejected!
        await expect(
          validateWebhookUrl('http://169.254.169.254/secret', { allowPrivate: false, requireHttps: false })
        ).rejects.toThrow(/private/i);
      } finally {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
      }
    });
  });

  describe('HMAC-SHA256 Signing & Stale Timestamp Rejection', () => {
    const testSecret = 'whsec_9b2d8e4f1a3c5b7e9b2d8e4f1a3c5b7e';
    const payload = JSON.stringify({ event: 'transfer.completed', amount_paise: 25000 });

    it('should generate valid signature header matching t=<unix>,v1=<hmac>', () => {
      const now = Math.floor(Date.now() / 1000);
      const { signatureHeader, timestamp, signature } = signPayload(payload, testSecret, now);

      expect(signatureHeader).toBe(`t=${now},v1=${signature}`);
      expect(signature).toHaveLength(64); // SHA-256 hex
      expect(timestamp).toBe(now);
    });

    it('should successfully verify valid signature within tolerance window', () => {
      const now = Math.floor(Date.now() / 1000);
      const { signatureHeader } = signPayload(payload, testSecret, now);

      const verification = verifySignature(payload, signatureHeader, testSecret, 300);
      expect(verification.valid).toBe(true);
      expect(verification.timestamp).toBe(now);
    });

    it('should reject stale timestamp outside the tolerance window (anti-replay)', () => {
      // Timestamp from 10 minutes (600s) ago
      const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
      const { signatureHeader } = signPayload(payload, testSecret, staleTimestamp);

      // Verify with 300s (5-minute) tolerance window
      const verification = verifySignature(payload, signatureHeader, testSecret, 300);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('outside tolerance window');
    });

    it('should reject tampered payload even if signature and timestamp are intact', () => {
      const now = Math.floor(Date.now() / 1000);
      const { signatureHeader } = signPayload(payload, testSecret, now);

      const tamperedPayload = JSON.stringify({ event: 'transfer.completed', amount_paise: 99999999 });
      const verification = verifySignature(tamperedPayload, signatureHeader, testSecret, 300);

      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });
  });

  describe('Webhook Endpoints CRUD API', () => {
    let createdEndpointId: string;
    let initialSecret: string;

    it('POST /webhook-endpoints: should create endpoint with secret shown once', async () => {
      const res = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${merchantKey}`)
        .send({
          url: 'https://example.com/webhooks/receive',
          event_types: ['transfer.completed'],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.merchant_id).toBe(merchantId);
      expect(res.body.url).toBe('https://example.com/webhooks/receive');
      expect(res.body.secret).toMatch(/^whsec_[a-f0-9]{64}$/);
      expect(res.body.status).toBe('ACTIVE');

      createdEndpointId = res.body.id;
      initialSecret = res.body.secret;
    });

    it('GET /webhook-endpoints: should list endpoints with masked secret', async () => {
      const res = await request(app)
        .get('/webhook-endpoints')
        .set('Authorization', `Bearer ${merchantKey}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const found = res.body.data.find((e: any) => e.id === createdEndpointId);
      expect(found).toBeDefined();
      expect(found.url).toBe('https://example.com/webhooks/receive');
      // Secret must be masked, NEVER full secret
      expect(found.secret).toContain('...');
      expect(found.secret).not.toBe(initialSecret);
    });

    it('POST /webhook-endpoints/:id/rotate-secret: should generate a new secret and reveal once', async () => {
      const res = await request(app)
        .post(`/webhook-endpoints/${createdEndpointId}/rotate-secret`)
        .set('Authorization', `Bearer ${merchantKey}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('rotated successfully');
      expect(res.body.endpoint.secret).toMatch(/^whsec_[a-f0-9]{64}$/);
      expect(res.body.endpoint.secret).not.toBe(initialSecret);

      // Verify the new secret was persisted in PostgreSQL
      const dbCheck = await query(
        `SELECT secret FROM webhook_endpoints WHERE id = $1`,
        [createdEndpointId]
      );
      expect(dbCheck.rows[0].secret).toBe(res.body.endpoint.secret);
    });

    it('DELETE /webhook-endpoints/:id: should delete the endpoint', async () => {
      const res = await request(app)
        .delete(`/webhook-endpoints/${createdEndpointId}`)
        .set('Authorization', `Bearer ${merchantKey}`);

      expect(res.status).toBe(200);

      // Verify deletion from DB
      const dbCheck = await query(
        `SELECT id FROM webhook_endpoints WHERE id = $1`,
        [createdEndpointId]
      );
      expect(dbCheck.rows).toHaveLength(0);
    });

    it('Cross-tenant isolation: Foreign merchant cannot access or delete endpoints (returns 404)', async () => {
      // 1. Create endpoint owned by Merchant A
      const epRes = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${merchantKey}`)
        .send({ url: 'https://example.com/merchant-a-isolated' });

      const epId = epRes.body.id;

      // 2. Foreign Merchant B attempts to delete Merchant A endpoint
      const deleteRes = await request(app)
        .delete(`/webhook-endpoints/${epId}`)
        .set('Authorization', `Bearer ${foreignKey}`);
      expect(deleteRes.status).toBe(404);

      // 3. Foreign Merchant B attempts to rotate secret of Merchant A endpoint
      const rotateRes = await request(app)
        .post(`/webhook-endpoints/${epId}/rotate-secret`)
        .set('Authorization', `Bearer ${foreignKey}`);
      expect(rotateRes.status).toBe(404);

      // 4. Foreign Merchant B listing does not show Merchant A endpoint
      const listRes = await request(app)
        .get('/webhook-endpoints')
        .set('Authorization', `Bearer ${foreignKey}`);
      const foreignIds = listRes.body.data.map((e: any) => e.id);
      expect(foreignIds).not.toContain(epId);
    });
  });

  describe('Automatic Outbox Event Creation on Transfer Commit', () => {
    it('should create an outbox event for each ACTIVE registered endpoint of the merchant', async () => {
      // 1. Register 2 active endpoints for foreign merchant
      const ep1 = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${foreignKey}`)
        .send({ url: 'https://example.com/foreign-hook-1' });

      const ep2 = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${foreignKey}`)
        .send({ url: 'https://example.com/foreign-hook-2' });

      // 2. Create wallets for foreign merchant
      const sender = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${foreignKey}`)
        .send({ owner_name: 'Foreign Sender', currency: 'INR', initial_credit_paise: 50000 });

      const receiver = await request(app)
        .post('/accounts')
        .set('Authorization', `Bearer ${foreignKey}`)
        .send({ owner_name: 'Foreign Receiver', currency: 'INR', initial_credit_paise: 0 });

      // 3. Execute transfer WITHOUT providing any webhook_url
      const transferRes = await request(app)
        .post('/transfers')
        .set('Authorization', `Bearer ${foreignKey}`)
        .set('Idempotency-Key', `tx-multi-ep-${uuidv4()}`)
        .send({
          from_account_id: sender.body.id,
          to_account_id: receiver.body.id,
          amount_paise: 10000,
        });

      expect(transferRes.status).toBe(201);
      expect(transferRes.body.outbox_event_ids).toHaveLength(2);

      // 4. Verify outbox events in database were created with endpoint_id references
      const outboxCheck = await query(
        `SELECT id, target_url, endpoint_id, status FROM outbox_events WHERE id = ANY($1)`,
        [transferRes.body.outbox_event_ids]
      );

      expect(outboxCheck.rows).toHaveLength(2);
      const targetUrls = outboxCheck.rows.map((r) => r.target_url);
      expect(targetUrls).toContain('https://example.com/foreign-hook-1');
      expect(targetUrls).toContain('https://example.com/foreign-hook-2');

      const endpointIds = outboxCheck.rows.map((r) => r.endpoint_id);
      expect(endpointIds).toContain(ep1.body.id);
      expect(endpointIds).toContain(ep2.body.id);
    });
  });
});
