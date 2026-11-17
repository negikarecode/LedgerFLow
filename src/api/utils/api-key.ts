import crypto from 'crypto';

export interface GeneratedApiKey {
  fullKey: string;
  prefix: string;
  hash: string;
}

/**
 * Generates an API key conforming to `lf_live_<random 32+ bytes base64url>`.
 * Returns the raw full key (to be displayed only once), the prefix for fast indexed lookup,
 * and the SHA-256 hash to be safely persisted in PostgreSQL.
 */
export function generateApiKey(): GeneratedApiKey {
  const randomBytes = crypto.randomBytes(32).toString('base64url');
  const fullKey = `lf_live_${randomBytes}`;
  const prefix = fullKey.slice(0, 16); // e.g. 'lf_live_aBcDeFgH'
  const hash = hashApiKey(fullKey);

  return {
    fullKey,
    prefix,
    hash,
  };
}

/**
 * Computes the SHA-256 hash of an API key as a hex string.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Constant-time comparison between a candidate key hash and a stored key hash.
 * Protects against timing side-channel attacks.
 */
export function verifyApiKeyHash(candidateHashHex: string, storedHashHex: string): boolean {
  try {
    const candidateBuf = Buffer.from(candidateHashHex, 'hex');
    const storedBuf = Buffer.from(storedHashHex, 'hex');

    if (candidateBuf.length !== storedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(candidateBuf, storedBuf);
  } catch {
    return false;
  }
}
