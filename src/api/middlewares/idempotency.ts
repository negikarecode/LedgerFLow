import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { redis } from '../../redis/client';
import { query } from '../../db/pool';
import { env } from '../../config/env';
import { transfersTotal, idempotencyReplaysTotal } from '../../observability/metrics';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

declare global {
  namespace Express {
    interface Request {
      idempotency?: {
        key: string;
        merchantId: string;
        redisKey: string;
        lockToken: string;
        requestHash: string;
        redisAvailable: boolean;
      };
    }
  }
}

/**
 * Compare-and-delete Lua script to ensure ONLY the owner holding the unique lock token
 * can release or delete the distributed lock.
 */
const COMPARE_AND_DEL_LUA = `
local current = redis.call("get", KEYS[1])
if not current then
  return 0
end
if current == ARGV[1] then
  return redis.call("del", KEYS[1])
end
local ok, data = pcall(cjson.decode, current)
if ok and data and data.token == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * Safely releases a Redis distributed lock using a unique owner token.
 */
export async function releaseSafeLock(redisKey: string, lockToken: string): Promise<boolean> {
  try {
    const res = await redis.eval(COMPARE_AND_DEL_LUA, 1, redisKey, lockToken);
    return res === 1;
  } catch (err) {
    console.warn('[Idempotency] Failed to release lock safely:', (err as any)?.message);
    return false;
  }
}

/**
 * Recursively canonicalizes JSON by sorting object keys at all nesting depths.
 * Primitive values and array order are preserved.
 */
export function canonicalizeJson(value: any): any {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  const sortedKeys = Object.keys(value).sort();
  const result: Record<string, any> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalizeJson(value[key]);
  }
  return result;
}

/**
 * Computes a deterministic SHA-256 fingerprint from the HTTP method, normalized path,
 * and canonicalized request body.
 */
export function computeRequestFingerprint(method: string, path: string, body: any): string {
  const normMethod = (method || 'POST').toUpperCase();
  const normPath = (path || '').split('?')[0].replace(/\/+$/, '') || '/';
  const canonicalBody = canonicalizeJson(body ?? {});
  const bodyString = JSON.stringify(canonicalBody);
  const data = `${normMethod}:${normPath}:${bodyString}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Backward compatibility alias for hashRequestBody.
 */
export function hashRequestBody(body: any): string {
  return computeRequestFingerprint('POST', '/transfers', body);
}

/**
 * Prunes expired idempotency records from PostgreSQL based on configured retention (default 24h).
 */
export async function cleanupExpiredIdempotencyKeys(
  retentionSeconds: number = env.IDEMPOTENCY_RETENTION_SECONDS
): Promise<number> {
  const result = await query(
    `DELETE FROM idempotency_keys 
     WHERE created_at < NOW() - ($1 || ' seconds')::INTERVAL`,
    [`${retentionSeconds}`]
  );
  return result.rowCount || 0;
}

/**
 * Idempotency middleware for mutating endpoints.
 * Provides multi-tier defense:
 * 1. Redis fast-path distributed locking with owner token & TTL
 * 2. Deterministic request fingerprinting (method + path + canonicalized body)
 * 3. PostgreSQL durable source-of-truth fallback (operates safely even if Redis is down)
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idempotencyKey =
    req.header('idempotency-key') || (req.headers['idempotency-key'] as string);

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    res.status(400).json({
      error: 'Bad Request',
      message: 'Idempotency-Key header is required',
    });
    return;
  }

  const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;
  const trimmedKey = idempotencyKey.trim();
  const redisKey = `idemp:${merchantId}:${trimmedKey}`;
  const requestPath = (req.baseUrl + req.path).replace(/\/+$/, '') || '/';
  const requestFingerprint = computeRequestFingerprint(req.method, requestPath, req.body);
  const lockToken = uuidv4();

  const lockPayload = JSON.stringify({
    status: 'IN_FLIGHT',
    token: lockToken,
    request_hash: requestFingerprint,
  });

  let lockAcquired = false;
  let redisAvailable = true;

  try {
    // 1. Fast-Path: Attempt distributed lock in Redis (30-second TTL)
    const lockResult = await redis.set(redisKey, lockPayload, 'EX', 30, 'NX');
    lockAcquired = lockResult === 'OK';

    if (!lockAcquired) {
      // Key already exists in Redis
      const existingVal = await redis.get(redisKey);

      if (existingVal === 'LOCKED') {
        // Legacy format lock in-flight
        transfersTotal.inc({ outcome: 'conflict' });
        res.status(409).json({
          error: 'Conflict',
          message: 'Request already in progress',
        });
        return;
      }

      if (existingVal) {
        try {
          const parsed = JSON.parse(existingVal);

          // Case A: Key is currently in flight
          if (parsed.status === 'IN_FLIGHT') {
            if (parsed.request_hash && parsed.request_hash !== requestFingerprint) {
              transfersTotal.inc({ outcome: 'key_reuse_mismatch' });
              res.status(422).json({
                error: 'Unprocessable Entity',
                code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
                message:
                  'Idempotency key has already been used with a different request payload or endpoint',
              });
              return;
            }
            transfersTotal.inc({ outcome: 'conflict' });
            res.status(409).json({
              error: 'Conflict',
              message: 'Request already in progress',
            });
            return;
          }

          // Case B: Completed cached response
          if (parsed.response_status) {
            if (parsed.request_hash && parsed.request_hash !== requestFingerprint) {
              transfersTotal.inc({ outcome: 'key_reuse_mismatch' });
              res.status(422).json({
                error: 'Unprocessable Entity',
                code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
                message:
                  'Idempotency key has already been used with a different request payload or endpoint',
              });
              return;
            }

            transfersTotal.inc({ outcome: 'replay' });
            idempotencyReplaysTotal.inc();
            res.setHeader('X-Idempotent-Replay', 'true');
            res.status(parsed.response_status).json(parsed.response_body);
            return;
          }
        } catch {
          // If JSON parse fails, fall through to PostgreSQL verification
        }
      }
    }
  } catch (redisErr) {
    redisAvailable = false;
    console.warn(
      '[Idempotency] Redis unavailable, using PostgreSQL as single source of truth:',
      (redisErr as any)?.message
    );
  }

  // 2. PostgreSQL Check (Source of Truth for completed transfers)
  try {
    const dbResult = await query(
      `SELECT key, merchant_id, request_hash, response_status, response_body 
       FROM idempotency_keys 
       WHERE key = $1 AND merchant_id = $2`,
      [trimmedKey, merchantId]
    );

    if (dbResult.rows.length > 0) {
      const stored = dbResult.rows[0];

      if (stored.response_status !== null) {
        if (stored.request_hash === requestFingerprint) {
          // Populate Redis cache if Redis is up
          if (redisAvailable) {
            try {
              await redis.set(
                redisKey,
                JSON.stringify({
                  request_hash: stored.request_hash,
                  response_status: stored.response_status,
                  response_body: stored.response_body,
                }),
                'EX',
                env.IDEMPOTENCY_RETENTION_SECONDS
              );
            } catch {
              // Redis failure is non-fatal
            }
          }

          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(stored.response_status).json(stored.response_body);
          return;
        } else {
          // Fingerprint mismatch between request and stored durable record
          if (redisAvailable && lockAcquired) {
            await releaseSafeLock(redisKey, lockToken);
          }
          res.status(422).json({
            error: 'Unprocessable Entity',
            code: 'IDEMPOTENCY_KEY_REUSE_WITH_DIFFERENT_PAYLOAD',
            message:
              'Idempotency key has already been used with a different request payload or endpoint',
          });
          return;
        }
      }
    }

    // 3. Attach idempotency context to request for downstream transactional engine
    req.idempotency = {
      key: trimmedKey,
      merchantId,
      redisKey,
      lockToken,
      requestHash: requestFingerprint,
      redisAvailable,
    };

    // Safe lock cleanup on failure/rejection (HTTP status !== 201)
    const releaseLockOnFailure = async () => {
      if (res.statusCode !== 201 && redisAvailable) {
        await releaseSafeLock(redisKey, lockToken);
      }
    };

    res.on('finish', releaseLockOnFailure);
    res.on('close', releaseLockOnFailure);

    next();
  } catch (err) {
    if (redisAvailable && lockAcquired) {
      await releaseSafeLock(redisKey, lockToken);
    }
    next(err);
  }
}
