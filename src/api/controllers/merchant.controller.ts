import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { redis } from '../../redis/client';
import { verifySignature } from '../../worker/signature';

let inMemoryCrashMode = false;
let inMemoryEvents: any[] = [];

export async function getCrashMode(): Promise<boolean> {
  try {
    const val = await redis.get('mock_merchant:crash_mode');
    if (val !== null) {
      return val === 'true';
    }
  } catch {
    // Fallback to in-memory
  }
  return inMemoryCrashMode;
}

export async function setCrashMode(crash: boolean): Promise<boolean> {
  inMemoryCrashMode = crash;
  try {
    await redis.set('mock_merchant:crash_mode', crash ? 'true' : 'false');
  } catch {
    // Fallback to in-memory
  }
  return inMemoryCrashMode;
}

export async function getReceivedEvents(): Promise<any[]> {
  try {
    const items = await redis.lrange('mock_merchant:events', 0, 49);
    if (items && items.length > 0) {
      return items.map((i) => JSON.parse(i));
    }
  } catch {
    // Fallback to in-memory
  }
  return inMemoryEvents;
}

export async function addReceivedEvent(event: any): Promise<void> {
  inMemoryEvents.unshift(event);
  if (inMemoryEvents.length > 50) {
    inMemoryEvents.pop();
  }

  try {
    await redis.lpush('mock_merchant:events', JSON.stringify(event));
    await redis.ltrim('mock_merchant:events', 0, 49);
  } catch {
    // Fallback to in-memory
  }
}

export async function clearReceivedEvents(): Promise<void> {
  inMemoryEvents = [];
  inMemoryCrashMode = false;
  try {
    await redis.del('mock_merchant:events');
    await redis.set('mock_merchant:crash_mode', 'false');
  } catch {
    // Fallback to in-memory
  }
}

/**
 * Mock Merchant Webhook Receiver: verifies HMAC signature, respects crash mode.
 */
export async function handleMerchantWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const signatureHeader =
      req.header('x-ledgerflow-signature') ||
      (req.headers['x-ledgerflow-signature'] as string);

    const payloadString = JSON.stringify(req.body);

    // 1. Verify HMAC-SHA256 signature
    const verification = verifySignature(
      payloadString,
      signatureHeader,
      env.WEBHOOK_SECRET
    );

    if (!verification.valid) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or missing X-LedgerFlow-Signature',
        reason: verification.reason,
      });
      return;
    }

    // 2. Check if Crash Mode is active
    const isCrashed = await getCrashMode();
    if (isCrashed) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Mock merchant server crashed (Crash Mode is ON)',
      });
      return;
    }

    // 3. Store valid incoming event
    const eventRecord = {
      id: uuidv4(),
      payload: req.body,
      signature: signatureHeader,
      received_at: new Date().toISOString(),
    };
    await addReceivedEvent(eventRecord);

    res.status(200).json({
      status: 'success',
      received: true,
      event_id: eventRecord.id,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Toggles or sets Crash Mode ON/OFF.
 */
export async function toggleMerchantCrash(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const current = await getCrashMode();
    let targetMode = !current;

    if (req.body && typeof req.body.crash === 'boolean') {
      targetMode = req.body.crash;
    }

    const updated = await setCrashMode(targetMode);

    res.status(200).json({
      crashMode: updated,
      message: updated
        ? 'Mock merchant crash mode ENABLED (returns 500)'
        : 'Mock merchant crash mode DISABLED (returns 200)',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Returns current merchant status and received webhook events.
 */
export async function getMerchantStatus(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const crashMode = await getCrashMode();
    const receivedEvents = await getReceivedEvents();

    res.status(200).json({
      crashMode,
      receivedEvents,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Clears mock merchant state for testing/demo resets.
 */
export async function resetMerchant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await clearReceivedEvents();
    res.status(200).json({
      message: 'Mock merchant state reset to default (crashMode: false, 0 events)',
      crashMode: false,
      receivedEvents: [],
    });
  } catch (err) {
    next(err);
  }
}
