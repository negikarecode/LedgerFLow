import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redis } from '../../redis/client';
import { query } from '../../db/pool';

declare global {
  namespace Express {
    interface Request {
      idempotency?: {
        key: string;
        redisKey: string;
        requestHash: string;
      };
    }
  }
}

export function hashRequestBody(body: any): string {
  if (body === undefined || body === null) {
    return crypto.createHash('sha256').update('').digest('hex');
  }
  if (typeof body === 'object') {
    const sortedKeys = Object.keys(body).sort();
    const sortedObj: Record<string, any> = {};
    for (const key of sortedKeys) {
      sortedObj[key] = body[key];
    }
    return crypto.createHash('sha256').update(JSON.stringify(sortedObj)).digest('hex');
  }
  return crypto.createHash('sha256').update(String(body)).digest('hex');
}

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

  const trimmedKey = idempotencyKey.trim();
  const redisKey = `idemp:${trimmedKey}`;
  const requestHash = hashRequestBody(req.body);

  try {
    // 1. Attempt to acquire in-flight distributed lock in Redis (30-second TTL)
    const lockAcquired = await redis.set(redisKey, 'LOCKED', 'EX', 30, 'NX');

    if (!lockAcquired) {
      // Key already present in Redis
      const existingVal = await redis.get(redisKey);

      if (existingVal === 'LOCKED') {
        res.status(409).json({
          error: 'Conflict',
          message: 'Request already in progress',
        });
        return;
      }

      if (existingVal) {
        try {
          const cached = JSON.parse(existingVal);
          if (cached.request_hash === requestHash) {
            res.setHeader('X-Idempotent-Replay', 'true');
            res.status(cached.response_status).json(cached.response_body);
            return;
          } else {
            res.status(409).json({
              error: 'Conflict',
              message: 'Idempotency key has already been used with different request parameters',
            });
            return;
          }
        } catch {
          // If JSON parse fails, fall through to database check
        }
      }
    }

    // 2. Lock acquired in Redis or Redis had invalid value; check PostgreSQL durable storage
    const dbResult = await query(
      `SELECT key, request_hash, response_status, response_body 
       FROM idempotency_keys 
       WHERE key = $1`,
      [trimmedKey]
    );

    if (dbResult.rows.length > 0) {
      const stored = dbResult.rows[0];

      if (stored.response_status !== null) {
        if (stored.request_hash === requestHash) {
          // Re-populate Redis cache with 24-hour TTL
          await redis.set(
            redisKey,
            JSON.stringify({
              request_hash: stored.request_hash,
              response_status: stored.response_status,
              response_body: stored.response_body,
            }),
            'EX',
            86400
          );

          res.setHeader('X-Idempotent-Replay', 'true');
          res.status(stored.response_status).json(stored.response_body);
          return;
        } else {
          // Release Redis lock since parameters don't match
          await redis.del(redisKey);
          res.status(409).json({
            error: 'Conflict',
            message: 'Idempotency key has already been used with different request parameters',
          });
          return;
        }
      }
    }

    // 3. New request: attach idempotency context to request
    req.idempotency = {
      key: trimmedKey,
      redisKey,
      requestHash,
    };

    // Clean up Redis lock if request does not complete with 201
    const releaseLockIfUnfinished = async () => {
      if (res.statusCode !== 201) {
        try {
          const current = await redis.get(redisKey);
          if (current === 'LOCKED') {
            await redis.del(redisKey);
          }
        } catch (err) {
          console.error('[Idempotency] Failed to release lock on error:', err);
        }
      }
    };

    res.on('finish', releaseLockIfUnfinished);
    res.on('close', releaseLockIfUnfinished);

    next();
  } catch (err) {
    next(err);
  }
}
