import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/pool';
import { validateWebhookUrl, SSRFError } from '../../security/ssrf';

const DEFAULT_DEMO_MERCHANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Generates a high-entropy endpoint secret conforming to Stripe style (`whsec_<hex>`).
 */
export function generateEndpointSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Mask an endpoint secret for safe listing (e.g. whsec_a1b2...c3d4).
 */
export function maskSecret(secret: string): string {
  if (!secret || secret.length < 12) return 'whsec_***';
  return `${secret.slice(0, 10)}...${secret.slice(-4)}`;
}

/**
 * POST /webhook-endpoints
 * Registers a new webhook endpoint for the authenticated merchant.
 * Generates and returns the endpoint secret exactly once.
 */
export async function createWebhookEndpoint(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { url, event_types = ['transfer.completed'] } = req.body;
  const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

  try {
    // SSRF Validation at registration time
    await validateWebhookUrl(url);

    const endpointId = uuidv4();
    const secret = generateEndpointSecret();

    const insertQuery = `
      INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
      VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
      RETURNING id, merchant_id, url, secret, event_types, status, created_at;
    `;
    const result = await query(insertQuery, [
      endpointId,
      merchantId,
      url,
      secret,
      event_types,
    ]);

    const created = result.rows[0];

    res.status(201).json({
      id: created.id,
      merchant_id: created.merchant_id,
      url: created.url,
      secret: created.secret, // Revealed exactly once
      event_types: created.event_types,
      status: created.status,
      created_at: created.created_at,
      warning: 'Store this webhook secret safely now. It will never be shown again in full.',
    });
  } catch (err: any) {
    if (err instanceof SSRFError) {
      res.status(400).json({
        error: 'Bad Request',
        message: err.message,
      });
      return;
    }
    next(err);
  }
}

/**
 * GET /webhook-endpoints
 * Lists all webhook endpoints for the authenticated merchant with masked secrets.
 */
export async function listWebhookEndpoints(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

  try {
    const result = await query(
      `SELECT id, merchant_id, url, secret, event_types, status, created_at
       FROM webhook_endpoints
       WHERE merchant_id = $1
       ORDER BY created_at DESC`,
      [merchantId]
    );

    res.status(200).json({
      data: result.rows.map((row) => ({
        id: row.id,
        merchant_id: row.merchant_id,
        url: row.url,
        secret: maskSecret(row.secret),
        event_types: row.event_types,
        status: row.status,
        created_at: row.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /webhook-endpoints/:id
 * Deletes or disables a webhook endpoint.
 */
export async function deleteWebhookEndpoint(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { id } = req.params;
  const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

  try {
    const result = await query(
      `DELETE FROM webhook_endpoints
       WHERE id = $1 AND merchant_id = $2
       RETURNING id`,
      [id, merchantId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Webhook endpoint with ID '${id}' not found`,
      });
      return;
    }

    res.status(200).json({
      message: 'Webhook endpoint deleted successfully',
      id,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /webhook-endpoints/:id/rotate-secret
 * Generates a new secret for an active webhook endpoint.
 * Returns the new secret exactly once.
 */
export async function rotateWebhookEndpointSecret(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { id } = req.params;
  const merchantId = req.merchant?.id || DEFAULT_DEMO_MERCHANT_ID;

  try {
    const existing = await query(
      `SELECT id, status FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2`,
      [id, merchantId]
    );

    if (existing.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Webhook endpoint with ID '${id}' not found`,
      });
      return;
    }

    const newSecret = generateEndpointSecret();

    const result = await query(
      `UPDATE webhook_endpoints
       SET secret = $1
       WHERE id = $2 AND merchant_id = $3
       RETURNING id, merchant_id, url, secret, event_types, status, created_at`,
      [newSecret, id, merchantId]
    );

    const updated = result.rows[0];

    res.status(200).json({
      message: 'Webhook secret rotated successfully',
      endpoint: {
        id: updated.id,
        merchant_id: updated.merchant_id,
        url: updated.url,
        secret: updated.secret, // Revealed exactly once
        event_types: updated.event_types,
        status: updated.status,
        created_at: updated.created_at,
        warning: 'Store this new webhook secret safely now. It will never be shown again in full.',
      },
    });
  } catch (err) {
    next(err);
  }
}
