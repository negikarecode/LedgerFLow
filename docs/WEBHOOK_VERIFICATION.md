# Webhook Verification & Replay Protection Guide

This guide describes how partner systems receive and cryptographically verify incoming webhook notifications dispatched by LedgerFlow.

---

## 1. Webhook Delivery Model & Identifiers

LedgerFlow guarantees **At-Least-Once** webhook delivery with deterministic deduplication identifiers. Every outbound HTTP POST request carries three distinct identity headers:

| Header | Description | Mutability Across Retries |
| :--- | :--- | :--- |
| `X-LedgerFlow-Event-Id` | Unique UUID of the domain event (e.g. `transfer.completed`). Also present in payload body as `event_id`. | **Immutable:** Remains identical across all delivery attempts and manual replays. |
| `X-LedgerFlow-Delivery-Id` | Unique UUIDv4 of this specific network transmission attempt. Also present in payload body as `delivery_id`. | **Unique Per Attempt:** Regenerated freshly on every retry. |
| `X-LedgerFlow-Signature` | Standard signature header containing timestamp `t` and HMAC digest `v1`. | **Fresh Per Attempt:** Recomputed with a fresh timestamp on every retry. |

### Payload Structure Example
```json
{
  "event_id": "00000000-0000-0000-0000-000000000001",
  "delivery_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "event": "transfer.completed",
  "transaction_id": "550e8400-e29b-41d4-a716-446655440000",
  "from_account_id": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  "to_account_id": "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
  "amount_paise": 25000,
  "currency": "INR",
  "status": "COMPLETED"
}
```

---

## 2. Canonical Message Format

Signatures are computed using **HMAC-SHA256** over a canonical message string:

$$\text{canonical\_message} = \text{timestamp} + \text{"."} + \text{raw\_payload}$$

- `timestamp`: Integer Unix timestamp in seconds (e.g. `1710000000`).
- `.`: Single ASCII period character (`0x2E`).
- `raw_payload`: Exact UTF-8 encoded string of the request body as received over the wire.

The signature is hex-encoded and attached in the header:
```http
X-LedgerFlow-Signature: t=1710000000,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

---

## 3. Two-Tier Replay Attack Prevention

To prevent replay attacks from malicious actors intercepting network traffic:

### Tier 1: Timestamp Freshness Window (300s Tolerance)
- Calculate the time difference: `diff = current_time - t`.
- Reject requests where `diff > 300` (older than 5 minutes).
- Reject requests where `diff < -60` (more than 60 seconds in the future).

### Tier 2: Delivery ID Deduplication Cache
- Within the 5-minute window, an attacker could replay an exact intercepted packet.
- Receivers must record seen `delivery_id` values in a fast cache (e.g., Redis) with a TTL of 300 seconds:
  ```redis
  SET "seen_delivery:${delivery_id}" "1" EX 300 NX
  ```
- If the key already exists, reject the request with **HTTP 409 Conflict** or return **HTTP 200** without reprocessing.

---

## 4. Receiver Implementation Examples

### Node.js / Express (TypeScript)

```typescript
import crypto from 'crypto';
import express, { Request, Response } from 'express';

const app = express();

// Capture raw body buffer for HMAC verification
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// In-memory or Redis delivery deduplication store (TTL: 300s)
const seenDeliveries = new Set<string>();

export function verifyWebhook(
  rawBody: string,
  signatureHeader: string,
  secretOrSecrets: string | string[],
  toleranceSeconds = 300
): { valid: boolean; reason?: string; event?: any } {
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing X-LedgerFlow-Signature header' };
  }

  // 1. Parse header components
  const parts = signatureHeader.split(',');
  let timestampStr: string | null = null;
  const candidateSignatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't') timestampStr = value;
    else if (key === 'v1' && value) candidateSignatures.push(value);
  }

  if (!timestampStr || candidateSignatures.length === 0) {
    return { valid: false, reason: 'Malformed signature header format' };
  }

  const timestamp = parseInt(timestampStr, 10);
  const now = Math.floor(Date.now() / 1000);

  // 2. Timestamp tolerance check
  if (now - timestamp > toleranceSeconds) {
    return { valid: false, reason: 'Signature timestamp outside tolerance window' };
  }
  if (timestamp - now > 60) {
    return { valid: false, reason: 'Signature timestamp is in the future' };
  }

  // 3. Compute expected HMAC-SHA256
  const canonicalMessage = `${timestamp}.${rawBody}`;
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];
  let matched = false;

  for (const secret of secrets) {
    const expectedHmac = crypto
      .createHmac('sha256', secret)
      .update(canonicalMessage)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedHmac, 'hex');

    for (const candSig of candidateSignatures) {
      if (!/^[0-9a-fA-F]{64}$/.test(candSig)) continue;
      const receivedBuf = Buffer.from(candSig, 'hex');

      // 4. Constant-time comparison
      if (expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  if (!matched) {
    return { valid: false, reason: 'Signature mismatch' };
  }

  const event = JSON.parse(rawBody);
  return { valid: true, event };
}

// Receiver Route Handler
app.post('/webhook', (req: any, res: Response) => {
  const signature = req.headers['x-ledgerflow-signature'] as string;
  const rawBody = req.rawBody;
  const WEBHOOK_SECRET = process.env.LEDGERFLOW_WEBHOOK_SECRET!;

  // 1. Verify cryptographic signature
  const verification = verifyWebhook(rawBody, signature, WEBHOOK_SECRET);
  if (!verification.valid) {
    return res.status(401).json({ error: 'Unauthorized', reason: verification.reason });
  }

  const event = verification.event;
  const deliveryId = event.delivery_id;
  const eventId = event.event_id;

  // 2. Transmission replay defense (delivery_id)
  if (seenDeliveries.has(deliveryId)) {
    return res.status(409).json({ error: 'Conflict', message: 'Duplicate delivery_id (replay detected)' });
  }
  seenDeliveries.add(deliveryId);

  // 3. Business logic deduplication (event_id)
  console.log(`Processing event ${eventId}:`, event);

  res.status(200).json({ received: true });
});
```

---

## 5. Zero-Downtime Secret Rotation

When rotating your endpoint signing secret via `POST /webhook-endpoints/:id/rotate-secret`:
1. LedgerFlow generates a new secret (e.g. `whsec_new...`).
2. Pass both secrets into your verification function: `verifyWebhook(rawBody, signature, [newSecret, oldSecret])`.
3. If dual-signing is active, LedgerFlow attaches both signatures: `t=...,v1=newSig,v1=oldSig`.
4. Once your receiver is verified on the new secret, remove the old secret from your configuration.
