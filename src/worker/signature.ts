import crypto from 'crypto';

export interface SignPayloadOptions {
  timestamp?: number;
  deliveryId?: string;
}

export interface SignatureResult {
  signatureHeader: string;
  timestamp: number;
  signature: string;
  deliveryId?: string;
  dataToSign: string;
}

export interface VerifySignatureOptions {
  toleranceSeconds?: number;
  futureToleranceSeconds?: number;
  enforceDeliveryId?: boolean;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
  matchedSecret?: string;
  deliveryId?: string;
}

/**
 * Builds the canonical message string to be signed with HMAC-SHA256:
 * Format: `${timestamp}.${payloadString}`
 * - timestamp: Unix epoch timestamp in seconds
 * - delimiter: ASCII period ('.', 0x2E)
 * - payloadString: Exact raw UTF-8 payload body
 */
export function buildCanonicalMessage(timestamp: number, payloadString: string): string {
  return `${timestamp}.${payloadString}`;
}

/**
 * Signs a webhook payload using HMAC-SHA256 over the canonical message format: `${timestamp}.${payloadString}`.
 * Header format: X-LedgerFlow-Signature: t=<unix_ts>,v1=<hmac_hex>
 * Supports dual-signing during secret rotation when an array of secrets is provided.
 */
export function signPayload(
  payloadString: string,
  secretOrSecrets: string | string[],
  options?: number | SignPayloadOptions
): SignatureResult {
  let ts: number;
  let deliveryId: string | undefined;

  if (typeof options === 'number') {
    ts = options;
  } else if (options && typeof options === 'object') {
    ts = options.timestamp ?? Math.floor(Date.now() / 1000);
    deliveryId = options.deliveryId;
  } else {
    ts = Math.floor(Date.now() / 1000);
  }

  // Extract delivery_id from payloadString if present and not explicitly provided
  if (!deliveryId) {
    try {
      const parsed = JSON.parse(payloadString);
      if (parsed && typeof parsed.delivery_id === 'string') {
        deliveryId = parsed.delivery_id;
      }
    } catch {}
  }

  const dataToSign = buildCanonicalMessage(ts, payloadString);
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];

  const signatures: string[] = [];
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string') continue;
    const sig = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex');
    signatures.push(sig);
  }

  const primarySig = signatures[0] || '';
  const sigPairs = signatures.map((sig) => `v1=${sig}`).join(',');
  const signatureHeader = `t=${ts},${sigPairs}`;

  return {
    signatureHeader,
    timestamp: ts,
    signature: primarySig,
    deliveryId,
    dataToSign,
  };
}

/**
 * Verifies an incoming X-LedgerFlow-Signature header using constant-time comparison.
 * Supports timestamp tolerance (anti-replay), future drift prevention, and candidate secrets (key rotation).
 */
export function verifySignature(
  payloadString: string,
  signatureHeader: string,
  secretOrSecrets: string | string[],
  optionsOrTolerance: number | VerifySignatureOptions = 300
): VerificationResult {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { valid: false, reason: 'Missing signature header' };
  }

  let toleranceSeconds = 300;
  let futureToleranceSeconds = 60;
  let enforceDeliveryId = false;

  if (typeof optionsOrTolerance === 'number') {
    toleranceSeconds = optionsOrTolerance;
    futureToleranceSeconds = optionsOrTolerance > 0 ? Math.min(optionsOrTolerance, 60) : 0;
  } else if (optionsOrTolerance && typeof optionsOrTolerance === 'object') {
    toleranceSeconds = optionsOrTolerance.toleranceSeconds ?? 300;
    futureToleranceSeconds = optionsOrTolerance.futureToleranceSeconds ?? 60;
    enforceDeliveryId = Boolean(optionsOrTolerance.enforceDeliveryId);
  }

  // Parse t=<ts>, v1=<sig>, v1=<sig2>
  const parts = signatureHeader.split(',');
  let timestampStr: string | null = null;
  const candidateSignatures: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (key === 't') {
      timestampStr = value;
    } else if (key === 'v1' && value) {
      candidateSignatures.push(value);
    }
  }

  if (!timestampStr || candidateSignatures.length === 0) {
    return { valid: false, reason: 'Malformed signature header format' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || timestamp <= 0) {
    return { valid: false, reason: 'Invalid timestamp in signature' };
  }

  const currentTs = Math.floor(Date.now() / 1000);

  // Check stale timestamp (outside tolerance window)
  if (toleranceSeconds > 0) {
    if (currentTs - timestamp > toleranceSeconds) {
      return {
        valid: false,
        reason: 'Signature timestamp outside tolerance window',
        timestamp,
      };
    }
  }

  // Check excessively future timestamp (clock drift exceeded)
  if (futureToleranceSeconds > 0) {
    if (timestamp - currentTs > futureToleranceSeconds) {
      return {
        valid: false,
        reason: 'Signature timestamp is in the future (clock drift exceeded)',
        timestamp,
      };
    }
  }

  const expectedToSign = buildCanonicalMessage(timestamp, payloadString);
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];
  let matchedSecret: string | null = null;

  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string') continue;

    const expectedHmac = crypto
      .createHmac('sha256', secret)
      .update(expectedToSign)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedHmac, 'hex');

    for (const candSig of candidateSignatures) {
      // Must be valid 64-char hex SHA-256 string
      if (!/^[0-9a-fA-F]{64}$/.test(candSig)) {
        continue;
      }

      const receivedBuffer = Buffer.from(candSig, 'hex');

      if (
        expectedBuffer.length === receivedBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
      ) {
        matchedSecret = secret;
        break;
      }
    }

    if (matchedSecret) break;
  }

  if (!matchedSecret) {
    return { valid: false, reason: 'Signature mismatch', timestamp };
  }

  // Extract delivery_id from payloadString if present
  let deliveryId: string | undefined;
  try {
    const parsed = JSON.parse(payloadString);
    if (parsed && typeof parsed.delivery_id === 'string') {
      deliveryId = parsed.delivery_id;
    }
  } catch {}

  if (enforceDeliveryId && !deliveryId) {
    return { valid: false, reason: 'Missing delivery_id in webhook payload', timestamp };
  }

  return {
    valid: true,
    timestamp,
    matchedSecret,
    deliveryId,
  };
}

/**
 * In-memory replay detector tracking processed delivery IDs within the tolerance window.
 * Receivers can use this (or a Redis SETNX equivalent) to prevent replay attacks.
 */
export class WebhookReplayDetector {
  private seenDeliveryIds = new Map<string, number>();
  private gcInterval: NodeJS.Timeout | null = null;

  constructor(private retentionSeconds = 300) {
    this.gcInterval = setInterval(() => this.cleanup(), 60000);
    this.gcInterval.unref?.();
  }

  /**
   * Checks whether deliveryId has already been seen.
   * If fresh, records it and returns { isReplay: false }.
   * If already seen, returns { isReplay: true, seenAt }.
   */
  checkAndRecord(deliveryId: string): { isReplay: boolean; seenAt?: number } {
    if (!deliveryId) {
      return { isReplay: false };
    }

    const now = Date.now();
    const existing = this.seenDeliveryIds.get(deliveryId);

    if (existing && now - existing < this.retentionSeconds * 1000) {
      return { isReplay: true, seenAt: existing };
    }

    this.seenDeliveryIds.set(deliveryId, now);
    return { isReplay: false };
  }

  cleanup(): void {
    const cutoff = Date.now() - this.retentionSeconds * 1000;
    for (const [id, seenAt] of this.seenDeliveryIds.entries()) {
      if (seenAt < cutoff) {
        this.seenDeliveryIds.delete(id);
      }
    }
  }

  reset(): void {
    this.seenDeliveryIds.clear();
  }
}

/**
 * Standalone receiver-side verification helper.
 * Parses raw body, verifies signature against secret(s), enforces timestamp tolerance,
 * and checks replay detector if provided.
 */
export function verifyWebhookPayload(
  rawBody: string,
  signatureHeader: string,
  secretOrSecrets: string | string[],
  options: VerifySignatureOptions & { replayDetector?: WebhookReplayDetector } = {}
): {
  valid: boolean;
  reason?: string;
  timestamp?: number;
  deliveryId?: string;
  payload?: any;
} {
  const result = verifySignature(rawBody, signatureHeader, secretOrSecrets, options);
  if (!result.valid) {
    return result;
  }

  if (options.replayDetector && result.deliveryId) {
    const replayCheck = options.replayDetector.checkAndRecord(result.deliveryId);
    if (replayCheck.isReplay) {
      return {
        valid: false,
        reason: 'Duplicate delivery_id detected (replay attack prevention)',
        timestamp: result.timestamp,
        deliveryId: result.deliveryId,
      };
    }
  }

  let payload: any = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {}

  return {
    valid: true,
    timestamp: result.timestamp,
    deliveryId: result.deliveryId,
    payload,
  };
}
