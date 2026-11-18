import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { app } from '../src/api/app';
import {
  buildCanonicalMessage,
  signPayload,
  verifySignature,
  verifyWebhookPayload,
  WebhookReplayDetector,
} from '../src/worker/signature';
import { maskSecret } from '../src/api/controllers/webhook-endpoints.controller';

const DEMO_KEY = 'lf_live_demo_key_for_chaos_simulator_1234567890';
const TEST_SECRET = 'whsec_test_secret_for_hardening_audit_1234567890';

describe('Webhook Signing, Verification & Replay Protection Suite', () => {
  let replayDetector: WebhookReplayDetector;

  beforeEach(() => {
    replayDetector = new WebhookReplayDetector(300);
  });

  describe('1. Canonical Message Construction & Signature Generation', () => {
    it('constructs canonical message in exact format ${timestamp}.${payloadString}', () => {
      const ts = 1700000000;
      const rawPayload = JSON.stringify({ event: 'transfer.completed', amount_paise: 5000 });
      const canonical = buildCanonicalMessage(ts, rawPayload);

      expect(canonical).toBe(`1700000000.${rawPayload}`);
      expect(canonical.startsWith('1700000000.')).toBe(true);
    });

    it('generates standard RFC-style X-LedgerFlow-Signature: t=<unix_ts>,v1=<hmac_hex>', () => {
      const payload = JSON.stringify({
        event_id: uuidv4(),
        delivery_id: uuidv4(),
        event: 'transfer.completed',
      });
      const fixedTs = 1710000000;
      const res = signPayload(payload, TEST_SECRET, fixedTs);

      expect(res.timestamp).toBe(fixedTs);
      expect(res.signatureHeader).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
      expect(res.signature).toHaveLength(64);

      // Verify HMAC matches independent crypto computation
      const expectedHmac = crypto
        .createHmac('sha256', TEST_SECRET)
        .update(`1710000000.${payload}`)
        .digest('hex');
      expect(res.signature).toBe(expectedHmac);
      expect(res.dataToSign).toBe(`1710000000.${payload}`);
    });

    it('extracts or preserves delivery_id in SignatureResult', () => {
      const deliveryId = uuidv4();
      const payload = JSON.stringify({
        event_id: uuidv4(),
        delivery_id: deliveryId,
        event: 'transfer.completed',
      });
      const res = signPayload(payload, TEST_SECRET);
      expect(res.deliveryId).toBe(deliveryId);
    });
  });

  describe('2. Valid Signature Verification & Constant-Time Security', () => {
    it('verifies valid signature successfully within tolerance window', () => {
      const payload = JSON.stringify({ event: 'transfer.completed', amount_paise: 25000 });
      const signed = signPayload(payload, TEST_SECRET);

      const verification = verifySignature(payload, signed.signatureHeader, TEST_SECRET, 300);
      expect(verification.valid).toBe(true);
      expect(verification.timestamp).toBe(signed.timestamp);
      expect(verification.matchedSecret).toBe(TEST_SECRET);
    });

    it('rejects tampered payload even when signature and timestamp are unchanged', () => {
      const originalPayload = JSON.stringify({
        event_id: uuidv4(),
        amount_paise: 10000,
        recipient: 'acc_alice',
      });
      const signed = signPayload(originalPayload, TEST_SECRET);

      const tamperedPayload = JSON.stringify({
        event_id: uuidv4(),
        amount_paise: 99999999, // Altered amount!
        recipient: 'acc_alice',
      });

      const verification = verifySignature(tamperedPayload, signed.signatureHeader, TEST_SECRET, 300);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });

    it('rejects signature verified with an incorrect secret', () => {
      const payload = JSON.stringify({ event: 'test' });
      const signed = signPayload(payload, TEST_SECRET);

      const verification = verifySignature(payload, signed.signatureHeader, 'whsec_wrong_key', 300);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });

    it('rejects signature with modified or corrupt hexadecimal bytes', () => {
      const payload = JSON.stringify({ event: 'test' });
      const signed = signPayload(payload, TEST_SECRET);

      // Flip first character of hex signature
      const corruptedSig = signed.signatureHeader.replace('v1=', 'v1=ff');
      const verification = verifySignature(payload, corruptedSig, TEST_SECRET, 300);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toBe('Signature mismatch');
    });
  });

  describe('3. Timestamp Tolerance, Clock Drift & Stale Replay Rejection', () => {
    it('rejects stale timestamp older than tolerance window (e.g. 301 seconds ago)', () => {
      const staleTimestamp = Math.floor(Date.now() / 1000) - 305;
      const payload = JSON.stringify({ event: 'transfer.completed' });
      const signed = signPayload(payload, TEST_SECRET, staleTimestamp);

      const verification = verifySignature(payload, signed.signatureHeader, TEST_SECRET, 300);
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('outside tolerance window');
    });

    it('accepts timestamp within tolerance window (e.g. 60 seconds ago)', () => {
      const recentTimestamp = Math.floor(Date.now() / 1000) - 60;
      const payload = JSON.stringify({ event: 'transfer.completed' });
      const signed = signPayload(payload, TEST_SECRET, recentTimestamp);

      const verification = verifySignature(payload, signed.signatureHeader, TEST_SECRET, 300);
      expect(verification.valid).toBe(true);
    });

    it('rejects excessively future timestamp (clock drift exceeded, e.g. 120s in the future)', () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 120;
      const payload = JSON.stringify({ event: 'transfer.completed' });
      const signed = signPayload(payload, TEST_SECRET, futureTimestamp);

      const verification = verifySignature(payload, signed.signatureHeader, TEST_SECRET, {
        toleranceSeconds: 300,
        futureToleranceSeconds: 60,
      });
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('in the future');
    });

    it('accepts minor acceptable forward clock skew (e.g. 15 seconds in future)', () => {
      const nearFutureTimestamp = Math.floor(Date.now() / 1000) + 15;
      const payload = JSON.stringify({ event: 'transfer.completed' });
      const signed = signPayload(payload, TEST_SECRET, nearFutureTimestamp);

      const verification = verifySignature(payload, signed.signatureHeader, TEST_SECRET, {
        toleranceSeconds: 300,
        futureToleranceSeconds: 60,
      });
      expect(verification.valid).toBe(true);
    });
  });

  describe('4. Malformed Header Parsing & Edge Cases', () => {
    const payload = JSON.stringify({ event: 'test' });

    it('rejects empty or missing signature header', () => {
      expect(verifySignature(payload, '', TEST_SECRET).valid).toBe(false);
      expect(verifySignature(payload, '   ', TEST_SECRET).valid).toBe(false);
    });

    it('rejects headers missing timestamp (t=) or signature (v1=)', () => {
      expect(verifySignature(payload, 'v1=1234567890abcdef', TEST_SECRET).valid).toBe(false);
      expect(verifySignature(payload, 't=1700000000', TEST_SECRET).valid).toBe(false);
      expect(verifySignature(payload, 'random-garbage-string', TEST_SECRET).valid).toBe(false);
    });

    it('rejects non-numeric or negative timestamps', () => {
      const fakeSig = 'a'.repeat(64);
      expect(verifySignature(payload, `t=notanumber,v1=${fakeSig}`, TEST_SECRET).valid).toBe(false);
      expect(verifySignature(payload, `t=-50,v1=${fakeSig}`, TEST_SECRET).valid).toBe(false);
    });

    it('rejects non-hex characters in v1 signature digest', () => {
      const now = Math.floor(Date.now() / 1000);
      const invalidHexSig = 'z'.repeat(64);
      const res = verifySignature(payload, `t=${now},v1=${invalidHexSig}`, TEST_SECRET);
      expect(res.valid).toBe(false);
      expect(res.reason).toBe('Signature mismatch');
    });
  });

  describe('5. Delivery ID Transmission & Replay Attack Prevention', () => {
    it('WebhookReplayDetector records first arrival and rejects replayed delivery_id', () => {
      const deliveryId = uuidv4();

      // First arrival: Fresh transmission
      const firstCheck = replayDetector.checkAndRecord(deliveryId);
      expect(firstCheck.isReplay).toBe(false);

      // Second arrival: Replayed transmission within tolerance window
      const secondCheck = replayDetector.checkAndRecord(deliveryId);
      expect(secondCheck.isReplay).toBe(true);
      expect(secondCheck.seenAt).toBeDefined();
    });

    it('verifyWebhookPayload helper blocks replay attempts via delivery_id', () => {
      const deliveryId = uuidv4();
      const payload = JSON.stringify({
        event_id: uuidv4(),
        delivery_id: deliveryId,
        event: 'transfer.completed',
        amount_paise: 5000,
      });

      const signed = signPayload(payload, TEST_SECRET);

      // 1. Initial valid reception
      const r1 = verifyWebhookPayload(payload, signed.signatureHeader, TEST_SECRET, {
        toleranceSeconds: 300,
        replayDetector,
      });
      expect(r1.valid).toBe(true);
      expect(r1.deliveryId).toBe(deliveryId);
      expect(r1.payload.event).toBe('transfer.completed');

      // 2. Exact packet replayed by attacker within tolerance window
      const r2 = verifyWebhookPayload(payload, signed.signatureHeader, TEST_SECRET, {
        toleranceSeconds: 300,
        replayDetector,
      });
      expect(r2.valid).toBe(false);
      expect(r2.reason).toContain('Duplicate delivery_id detected');
    });
  });

  describe('6. Retry Semantics: Stable Event ID with Fresh Delivery ID & Timestamp', () => {
    it('ensures retries maintain the same event_id while using a fresh delivery_id and signature', () => {
      const stableEventId = uuidv4();
      const initialDeliveryId = uuidv4();
      const retryDeliveryId = uuidv4();

      const time1 = 1700000000;
      const time2 = 1700000030; // 30 seconds later

      // Attempt 1 payload
      const payload1 = JSON.stringify({
        event_id: stableEventId,
        delivery_id: initialDeliveryId,
        event: 'transfer.completed',
        amount_paise: 10000,
      });
      const sig1 = signPayload(payload1, TEST_SECRET, time1);

      // Attempt 2 (Retry) payload
      const payload2 = JSON.stringify({
        event_id: stableEventId, // Same stable business event
        delivery_id: retryDeliveryId, // Fresh unique delivery identifier
        event: 'transfer.completed',
        amount_paise: 10000,
      });
      const sig2 = signPayload(payload2, TEST_SECRET, time2);

      // Assertions on retry invariants:
      expect(JSON.parse(payload1).event_id).toBe(JSON.parse(payload2).event_id);
      expect(sig1.deliveryId).not.toBe(sig2.deliveryId);
      expect(sig1.timestamp).toBe(time1);
      expect(sig2.timestamp).toBe(time2);
      expect(sig1.signature).not.toBe(sig2.signature);

      // Both signatures verify accurately
      expect(verifySignature(payload1, sig1.signatureHeader, TEST_SECRET, 0).valid).toBe(true);
      expect(verifySignature(payload2, sig2.signatureHeader, TEST_SECRET, 0).valid).toBe(true);
    });
  });

  describe('7. Secret Storage, Masking & Key Rotation', () => {
    it('maskSecret masks signing secrets safely (whsec_a1b2...c3d4)', () => {
      const secret = 'whsec_9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
      const masked = maskSecret(secret);

      expect(masked).toBe('whsec_9f86...0a08');
      expect(masked).not.toContain(secret.slice(10, -4));
    });

    it('supports key rotation verification with multiple candidate secrets', () => {
      const oldSecret = 'whsec_old_secret_key_1111111111111111';
      const newSecret = 'whsec_new_secret_key_2222222222222222';
      const candidateSecrets = [newSecret, oldSecret];

      const payload = JSON.stringify({ event: 'transfer.completed' });

      // Event signed with old secret verifies against candidate list
      const signedOld = signPayload(payload, oldSecret);
      const vOld = verifySignature(payload, signedOld.signatureHeader, candidateSecrets, 300);
      expect(vOld.valid).toBe(true);
      expect(vOld.matchedSecret).toBe(oldSecret);

      // Event signed with new secret verifies against candidate list
      const signedNew = signPayload(payload, newSecret);
      const vNew = verifySignature(payload, signedNew.signatureHeader, candidateSecrets, 300);
      expect(vNew.valid).toBe(true);
      expect(vNew.matchedSecret).toBe(newSecret);

      // Event signed with unrelated secret fails
      const signedOther = signPayload(payload, 'whsec_unrelated_secret_3333333333');
      const vOther = verifySignature(payload, signedOther.signatureHeader, candidateSecrets, 300);
      expect(vOther.valid).toBe(false);
      expect(vOther.reason).toBe('Signature mismatch');
    });

    it('supports dual-signing during zero-downtime secret rotation transitions', () => {
      const oldSecret = 'whsec_old_1111111111111111';
      const newSecret = 'whsec_new_2222222222222222';

      const payload = JSON.stringify({ event: 'transfer.completed' });
      // Dual-sign payload with both secrets
      const dualSigned = signPayload(payload, [newSecret, oldSecret]);

      expect(dualSigned.signatureHeader).toContain('v1=');
      // Header contains two v1 signatures
      const v1Matches = dualSigned.signatureHeader.match(/v1=/g);
      expect(v1Matches?.length).toBe(2);

      // Partner who only has oldSecret verifies successfully
      const checkOld = verifySignature(payload, dualSigned.signatureHeader, oldSecret, 300);
      expect(checkOld.valid).toBe(true);
      expect(checkOld.matchedSecret).toBe(oldSecret);

      // Partner who updated to newSecret verifies successfully
      const checkNew = verifySignature(payload, dualSigned.signatureHeader, newSecret, 300);
      expect(checkNew.valid).toBe(true);
      expect(checkNew.matchedSecret).toBe(newSecret);
    });

    it('API never returns full plaintext secrets on list or get endpoints', async () => {
      // 1. Create an endpoint
      const createRes = await request(app)
        .post('/webhook-endpoints')
        .set('Authorization', `Bearer ${DEMO_KEY}`)
        .send({
          url: 'https://example.com/webhook',
          event_types: ['transfer.completed'],
        });

      expect(createRes.status).toBe(201);
      const endpointId = createRes.body.id;
      const fullSecret = createRes.body.secret;
      expect(fullSecret).toMatch(/^whsec_[a-f0-9]{64}$/);

      // 2. GET /webhook-endpoints/:id MUST MASK secret
      const getRes = await request(app)
        .get(`/webhook-endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.secret).not.toBe(fullSecret);
      expect(getRes.body.secret).toMatch(/^whsec_[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/);

      // 3. GET /webhook-endpoints (list) MUST MASK secret
      const listRes = await request(app)
        .get('/webhook-endpoints')
        .set('Authorization', `Bearer ${DEMO_KEY}`);

      expect(listRes.status).toBe(200);
      const found = listRes.body.data.find((e: any) => e.id === endpointId);
      expect(found).toBeDefined();
      expect(found.secret).not.toBe(fullSecret);
      expect(found.secret).toMatch(/^whsec_[a-f0-9]{4}\.\.\.[a-f0-9]{4}$/);

      // 4. Clean up endpoint
      await request(app)
        .delete(`/webhook-endpoints/${endpointId}`)
        .set('Authorization', `Bearer ${DEMO_KEY}`);
    });
  });
});
