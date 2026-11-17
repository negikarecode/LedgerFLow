import crypto from 'crypto';

export interface SignatureResult {
  signatureHeader: string;
  timestamp: number;
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

/**
 * Signs a webhook payload using HMAC-SHA256.
 * Header format: X-LedgerFlow-Signature: t=<unix_ts>,v1=<hmac_hex>
 */
export function signPayload(
  payloadString: string,
  secret: string,
  timestamp?: number
): SignatureResult {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const dataToSign = `${ts}.${payloadString}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex');

  return {
    signatureHeader: `t=${ts},v1=${signature}`,
    timestamp: ts,
    signature,
  };
}

/**
 * Verifies an incoming X-LedgerFlow-Signature header.
 */
export function verifySignature(
  payloadString: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): VerificationResult {
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing signature header' };
  }

  // Parse t=<ts>,v1=<sig>
  const parts = signatureHeader.split(',');
  let timestampStr: string | null = null;
  let signatureHex: string | null = null;

  for (const part of parts) {
    const [key, value] = part.trim().split('=');
    if (key === 't') {
      timestampStr = value;
    } else if (key === 'v1') {
      signatureHex = value;
    }
  }

  if (!timestampStr || !signatureHex) {
    return { valid: false, reason: 'Malformed signature header format' };
  }

  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    return { valid: false, reason: 'Invalid timestamp in signature' };
  }

  // Check tolerance / replay window if specified
  if (toleranceSeconds > 0) {
    const currentTs = Math.floor(Date.now() / 1000);
    if (Math.abs(currentTs - timestamp) > toleranceSeconds) {
      return { valid: false, reason: 'Signature timestamp outside tolerance window', timestamp };
    }
  }

  const expectedToSign = `${timestamp}.${payloadString}`;
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(expectedToSign)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedHmac, 'hex');
  const receivedBuffer = Buffer.from(signatureHex, 'hex');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return { valid: false, reason: 'Signature mismatch', timestamp };
  }

  const matches = crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  if (!matches) {
    return { valid: false, reason: 'Signature mismatch', timestamp };
  }

  return { valid: true, timestamp };
}
