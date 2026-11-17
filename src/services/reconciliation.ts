import { query } from '../db/pool';
import { logger } from '../observability/logger';

export interface AccountDiscrepancy {
  account_id: string;
  merchant_id: string;
  owner_name: string;
  cached_balance_paise: number;
  computed_balance_paise: number;
  discrepancy_paise: number;
}

export interface ReconciliationReport {
  timestamp: string;
  total_accounts_checked: number;
  discrepancies_found: number;
  discrepancies: AccountDiscrepancy[];
  double_entry_net_discrepancy_paise: number;
  status: 'HEALTHY' | 'DISCREPANCY_DETECTED';
}

/**
 * Reconciles cached account balance_paise against the mathematical SUM
 * of all immutable ledger_entries, and verifies double-entry balance conservation.
 */
export async function reconcileAccountBalances(options?: {
  autoRepair?: boolean;
  merchantId?: string;
}): Promise<ReconciliationReport> {
  const checkParams: any[] = [];
  let whereClause = '';
  if (options?.merchantId) {
    checkParams.push(options.merchantId);
    whereClause = `WHERE a.merchant_id = $1`;
  }

  // 1. Check all account balance vs ledger_entries SUM
  const checkQuery = `
    SELECT 
      a.id AS account_id,
      a.merchant_id,
      a.owner_name,
      a.balance_paise AS cached_balance_paise,
      COALESCE(SUM(
        CASE 
          WHEN le.entry_type = 'CREDIT' THEN le.amount
          WHEN le.entry_type = 'DEBIT' THEN -le.amount
          ELSE 0
        END
      ), 0)::BIGINT AS computed_balance_paise,
      a.balance_paise - COALESCE(SUM(
        CASE 
          WHEN le.entry_type = 'CREDIT' THEN le.amount
          WHEN le.entry_type = 'DEBIT' THEN -le.amount
          ELSE 0
        END
      ), 0)::BIGINT AS discrepancy_paise
    FROM accounts a
    LEFT JOIN ledger_entries le ON a.id = le.account_id
    ${whereClause}
    GROUP BY a.id, a.merchant_id, a.owner_name, a.balance_paise
    HAVING a.balance_paise != COALESCE(SUM(
      CASE 
        WHEN le.entry_type = 'CREDIT' THEN le.amount
        WHEN le.entry_type = 'DEBIT' THEN -le.amount
        ELSE 0
      END
    ), 0)::BIGINT;
  `;

  // 2. Count total accounts checked
  const countParams: any[] = [];
  let countWhere = '';
  if (options?.merchantId) {
    countParams.push(options.merchantId);
    countWhere = `WHERE merchant_id = $1`;
  }
  const countQuery = `SELECT COUNT(*)::INT AS total FROM accounts ${countWhere};`;

  // 3. Overall double-entry conservation invariant
  const conservationQuery = `
    SELECT COALESCE(
      SUM(CASE WHEN entry_type = 'DEBIT' THEN amount ELSE 0 END) -
      SUM(CASE WHEN entry_type = 'CREDIT' AND transaction_id IN (
        SELECT transaction_id FROM ledger_entries WHERE entry_type = 'DEBIT'
      ) THEN amount ELSE 0 END), 0
    )::BIGINT AS net_discrepancy_paise
    FROM ledger_entries;
  `;

  const [discrepanciesRes, countRes, conservationRes] = await Promise.all([
    query(checkQuery, checkParams),
    query(countQuery, countParams),
    query(conservationQuery),
  ]);

  const totalAccountsChecked = countRes.rows[0]?.total || 0;
  const netDiscrepancy = Number(conservationRes.rows[0]?.net_discrepancy_paise || 0);

  const discrepancies: AccountDiscrepancy[] = discrepanciesRes.rows.map((r) => ({
    account_id: r.account_id,
    merchant_id: r.merchant_id,
    owner_name: r.owner_name,
    cached_balance_paise: Number(r.cached_balance_paise),
    computed_balance_paise: Number(r.computed_balance_paise),
    discrepancy_paise: Number(r.discrepancy_paise),
  }));

  // Auto-repair if requested
  if (options?.autoRepair && discrepancies.length > 0) {
    for (const d of discrepancies) {
      await query(
        `UPDATE accounts SET balance_paise = $1 WHERE id = $2`,
        [d.computed_balance_paise, d.account_id]
      );
      logger.warn(
        {
          account_id: d.account_id,
          old_balance: d.cached_balance_paise,
          repaired_balance: d.computed_balance_paise,
        },
        '[Reconciliation] Repaired account balance to match ledger SUM'
      );
    }
  }

  const isHealthy = discrepancies.length === 0 && netDiscrepancy === 0;

  return {
    timestamp: new Date().toISOString(),
    total_accounts_checked: totalAccountsChecked,
    discrepancies_found: discrepancies.length,
    discrepancies,
    double_entry_net_discrepancy_paise: netDiscrepancy,
    status: isHealthy ? 'HEALTHY' : 'DISCREPANCY_DETECTED',
  };
}
