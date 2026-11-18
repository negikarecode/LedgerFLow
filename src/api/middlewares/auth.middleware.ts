import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../../db/pool';
import { env } from '../../config/env';
import { hashApiKey, verifyApiKeyHash } from '../utils/api-key';
import { authFailureTracker, getClientIp } from './rate-limit.middleware';

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
 * updates last_used_at asynchronously, and protects against brute-force attacks via authFailureTracker.
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientIp = getClientIp(req);

  // Check if IP is currently blocked by brute-force auth failure rate limiter
  const { blocked, resetSeconds } = await authFailureTracker.isBlocked(clientIp);
  if (blocked) {
    res.setHeader('Retry-After', resetSeconds);
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Too many failed authentication attempts. Please retry after ${resetSeconds} seconds.`,
      retry_after_seconds: resetSeconds,
    });
    return;
  }

  const authHeader = req.header('authorization') || (req.headers['authorization'] as string);

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    await authFailureTracker.recordFailure(clientIp);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Expected Bearer <api_key>',
    });
    return;
  }

  const rawKey = authHeader.slice(7).trim();

  // Strict format check: must start with lf_live_ followed by 20 to 128 url-safe characters
  if (!/^lf_live_[A-Za-z0-9_-]{20,128}$/.test(rawKey)) {
    await authFailureTracker.recordFailure(clientIp);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key format. Expected lf_live_<token>',
    });
    return;
  }

  const prefix = rawKey.slice(0, 16);
  const candidateHash = hashApiKey(rawKey);

  try {
    // Look up candidate keys by prefix
    const result = await query(
      `SELECT k.id, k.merchant_id, k.key_hash, k.revoked_at, k.expires_at, m.name as merchant_name
       FROM api_keys k
       JOIN merchants m ON m.id = k.merchant_id
       WHERE k.key_prefix = $1`,
      [prefix]
    );

    if (result.rows.length === 0) {
      await authFailureTracker.recordFailure(clientIp);
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
      await authFailureTracker.recordFailure(clientIp);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or revoked API key',
      });
      return;
    }

    if (matchedRow.revoked_at != null) {
      await authFailureTracker.recordFailure(clientIp);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key has been revoked',
      });
      return;
    }

    if (matchedRow.expires_at != null && new Date(matchedRow.expires_at).getTime() <= Date.now()) {
      await authFailureTracker.recordFailure(clientIp);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'API key has expired',
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
 * Also protected against brute-force attacks via authFailureTracker.
 */
export async function requireAdminToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientIp = getClientIp(req);

  // Check if IP is currently blocked by brute-force auth failure rate limiter
  const { blocked, resetSeconds } = await authFailureTracker.isBlocked(clientIp);
  if (blocked) {
    res.setHeader('Retry-After', resetSeconds);
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Too many failed authentication attempts. Please retry after ${resetSeconds} seconds.`,
      retry_after_seconds: resetSeconds,
    });
    return;
  }

  const authHeader = req.header('authorization') || (req.headers['authorization'] as string);

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    await authFailureTracker.recordFailure(clientIp);
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
      await authFailureTracker.recordFailure(clientIp);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid admin authorization token',
      });
      return;
    }

    next();
  } catch {
    await authFailureTracker.recordFailure(clientIp);
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid admin authorization token',
    });
  }
}
