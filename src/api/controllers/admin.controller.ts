import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClient, query } from '../../db/pool';
import { generateApiKey } from '../utils/api-key';

/**
 * Bootstrap Merchant Creation:
 * Creates a new merchant entity and generates its first API key.
 * Shows the full raw API key exactly once.
 */
export async function createMerchant(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    res.status(400).json({
      error: 'Validation failed',
      details: [{ field: 'name', message: 'Merchant name is required' }],
    });
    return;
  }

  const client = await getClient();

  try {
    await client.query('BEGIN');

    const merchantId = uuidv4();
    const insertMerchantQuery = `
      INSERT INTO merchants (id, name)
      VALUES ($1, $2)
      RETURNING id, name, created_at;
    `;
    const merchantResult = await client.query(insertMerchantQuery, [merchantId, name.trim()]);
    const merchant = merchantResult.rows[0];

    const { fullKey, prefix, hash } = generateApiKey();
    const keyId = uuidv4();

    const insertKeyQuery = `
      INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, key_prefix, created_at;
    `;
    const keyResult = await client.query(insertKeyQuery, [keyId, merchantId, prefix, hash]);
    const keyRecord = keyResult.rows[0];

    await client.query('COMMIT');

    res.status(201).json({
      merchant: {
        id: merchant.id,
        name: merchant.name,
        created_at: merchant.created_at,
      },
      api_key: {
        id: keyRecord.id,
        key: fullKey, // Revealed exactly once
        prefix: keyRecord.key_prefix,
        key_prefix: keyRecord.key_prefix,
        created_at: keyRecord.created_at,
        warning: 'Store this API key safely now. It will never be shown again.',
      },
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    next(err);
  } finally {
    client.release();
  }
}

/**
 * Generates an additional API key for an existing merchant.
 */
export async function createMerchantKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { id } = req.params;
  const { expires_at, expires_in_days } = req.body || {};

  try {
    const merchantCheck = await query('SELECT id, name FROM merchants WHERE id = $1', [id]);
    if (merchantCheck.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Merchant with ID '${id}' not found`,
      });
      return;
    }

    let calculatedExpiresAt: string | null = null;
    if (expires_at) {
      calculatedExpiresAt = new Date(expires_at).toISOString();
    } else if (expires_in_days && typeof expires_in_days === 'number' && expires_in_days > 0) {
      calculatedExpiresAt = new Date(Date.now() + expires_in_days * 86400000).toISOString();
    }

    const { fullKey, prefix, hash } = generateApiKey();
    const keyId = uuidv4();

    const insertKeyQuery = `
      INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, key_prefix, expires_at, created_at;
    `;
    const keyResult = await query(insertKeyQuery, [keyId, id, prefix, hash, calculatedExpiresAt]);
    const keyRecord = keyResult.rows[0];

    res.status(201).json({
      merchant_id: id,
      api_key: {
        id: keyRecord.id,
        key: fullKey,
        prefix: keyRecord.key_prefix,
        key_prefix: keyRecord.key_prefix,
        expires_at: keyRecord.expires_at,
        created_at: keyRecord.created_at,
        warning: 'Store this API key safely now. It will never be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Revokes an existing API key.
 */
export async function revokeApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { id } = req.params;

  try {
    const result = await query(
      `UPDATE api_keys 
       SET revoked_at = NOW() 
       WHERE id = $1 AND revoked_at IS NULL 
       RETURNING id, merchant_id, key_prefix, revoked_at`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: `Active API key with ID '${id}' not found or already revoked`,
      });
      return;
    }

    res.status(200).json({
      message: 'API key revoked successfully',
      key: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Admin Reconciliation Trigger:
 * Compares all accounts' cached balance_paise against SUM of ledger_entries,
 * and double-entry balance conservation across all transfers.
 */
export async function handleAdminReconcile(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawMerchantId = req.body?.merchant_id ?? req.query?.merchant_id;
    const rawAccountId = req.body?.account_id ?? req.query?.account_id;
    const autoRepair = req.body?.auto_repair === true;

    const merchantId = typeof rawMerchantId === 'string' && rawMerchantId.trim() ? rawMerchantId.trim() : undefined;
    const accountId = typeof rawAccountId === 'string' && rawAccountId.trim() ? rawAccountId.trim() : undefined;

    const { reconcileAccountBalances } = await import('../../services/reconciliation');
    const report = await reconcileAccountBalances({
      autoRepair,
      merchantId,
      accountId,
    });
    res.status(200).json(report);
  } catch (err) {
    next(err);
  }
}
