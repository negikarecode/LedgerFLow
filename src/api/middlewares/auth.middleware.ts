import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../../db/pool';
import { env } from '../../config/env';
import { hashApiKey, verifyApiKeyHash } from '../utils/api-key';

declare global {
  namespace Express {
    interface Request {
      merchant?: {
        id: string;
        apiKeyId: string;
        name?: string;
      };
    }
  }
}

/**
 * Express middleware to authenticate merchant API keys via `Authorization: Bearer <key>`.
 * Validates prefix, verifies SHA-256 hash in constant time, verifies non-revocation,
 * and updates last_used_at asynchronously.
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.header('authorization') || (req.headers['authorization'] as string);

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Expected Bearer <api_key>',
    });
    return;
  }

  const rawKey = authHeader.slice(7).trim();

  if (!rawKey.startsWith('lf_live_')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key format. Expected lf_live_<token>',
    });
    return;
  }

  const prefix = rawKey.slice(0, 16);
  const candidateHash = hashApiKey(rawKey);

  try {
    // Look up non-revoked candidate keys by prefix
    const result = await query(
      `SELECT k.id, k.merchant_id, k.key_hash, k.revoked_at, m.name as merchant_name
       FROM api_keys k
       JOIN merchants m ON m.id = k.merchant_id
       WHERE k.key_prefix = $1`,
      [prefix]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key',
      });
      return;
    }

    // Match candidate hash using constant-time comparison
    let matchedRow: any = null;
    for (const row of result.rows) {
      if (verifyApiKeyHash(candidateHash, row.key_hash)) {
        matchedRow = row;
        break;
      }
    }

    if (!matchedRow) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key',
      });
      return;
    }

    if (matchedRow.revoked_at != null) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key has been revoked',
      });
      return;
    }

    // Attach authenticated merchant to request context
    req.merchant = {
      id: matchedRow.merchant_id,
      apiKeyId: matchedRow.id,
      name: matchedRow.merchant_name,
    };

    // Update last_used_at asynchronously (non-blocking)
    query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [matchedRow.id]).catch(
      (err) => console.warn('[Auth] Failed to update key last_used_at:', err.message)
    );

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware to authenticate administrative bootstrap operations via ADMIN_TOKEN.
 */
export function requireAdminToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.header('authorization') || (req.headers['authorization'] as string);

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Expected Bearer <admin_token>',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  const expectedToken = env.ADMIN_TOKEN;

  // Constant-time comparison between candidate and expected token
  try {
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);

    if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid admin authorization token',
      });
      return;
    }

    next();
  } catch {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin authorization token',
    });
  }
}
