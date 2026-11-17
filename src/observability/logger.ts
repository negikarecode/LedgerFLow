import pino from 'pino';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env';

declare global {
  namespace Express {
    interface Request {
      id?: string;
      log?: pino.Logger;
    }
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Middleware that extracts or assigns a unique request ID (X-Request-Id)
 * and attaches a child JSON logger to req.log.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const reqId = (req.header('x-request-id') as string) || uuidv4();
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);

  const startTime = Date.now();
  req.log = logger.child({
    req_id: reqId,
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    // Do not flood logs with polling health and metrics checks unless in debug mode
    if (req.path === '/health' || req.path === '/metrics') {
      return;
    }

    req.log?.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: durationMs,
        merchant_id: req.merchant?.id,
      },
      `${req.method} ${req.path} completed with ${res.statusCode} in ${durationMs}ms`
    );
  });

  next();
}

/**
 * Creates a worker/job child logger bound to a specific request ID and event ID.
 */
export function createWorkerLogger(bindings: {
  reqId?: string;
  eventId?: string;
  deliveryId?: string;
  endpointId?: string;
}): pino.Logger {
  return logger.child({
    req_id: bindings.reqId,
    event_id: bindings.eventId,
    delivery_id: bindings.deliveryId,
    endpoint_id: bindings.endpointId,
  });
}
