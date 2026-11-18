import { getClient, query } from '../db/pool';
import { logger } from '../observability/logger';
import { MAX_SAFE_PAISE } from '../api/schemas/transfer.schema';

export interface AccountDiscrepancy {
  account_id: string;
  merchant_id: string;
  owner_name: string;
  stored_balance_paise: number;
  calculated_balance_paise: number;
  cached_balance_paise: number; // Backwards compatibility alias
  computed_balance_paise: number; // Backwards compatibility alias
  discrepancy_paise: number;
  status: 'BALANCE_MISMATCH';
}

export interface TransactionIntegrityViolation {
  transaction_id: string;
  violation_type:
    | 'UNBALANCED_TRANSFER'
    | 'MISSING_COUNTERPART'
    | 'DUPLICATE_ENTRIES'
    | 'MALFORMED_RECORD'
    | 'CROSS_TENANT_LEAKAGE';
  details: string;
  debit_paise: number;
  credit_paise: number;
  imbalance_paise: number;
  affected_accounts: string[];
}

export interface ReconciliationReport {
  timestamp: string;
  total_accounts_checked: number;
  total_transactions_checked: number;
  discrepancies_found: number;
  integrity_violations_found: number;
  discrepancies: AccountDiscrepancy[];
  integrity_violations: TransactionIntegrityViolation[];
  double_entry_net_discrepancy_paise: number;
  status: 'HEALTHY' | 'DISCREPANCY_DETECTED';
}

export interface ReconciliationOptions {
  autoRepair?: boolean;
  merchantId?: string;
  accountId?: string;
}

/**
 * Independently reconciles account balances against immutable ledger entries
 * and audits double-entry accounting integrity across all transactions.
 * 
 * Guarantees:
 * 1. Executes inside a REPEATABLE READ READ ONLY snapshot on a dedicated client
 *    to ensure point-in-time consistency against concurrent in-flight transfers.
 * 2. Strictly read-only by default; never silently repairs or mutates records.
 * 3. Scopes securely by merchantId and accountId when requested.
 * 4. Preserves immutable double-entry ledger history.
 */
export async function reconcileAccountBalances(
  options?: ReconciliationOptions
): Promise<ReconciliationReport> {
  const client = await getClient();

  try {
    // Acquire a consistent, point-in-time snapshot isolation level.
    // READ ONLY guarantees PostgreSQL forbids any accidental write/mutation in this session.
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const accountParams: any[] = [];
    const accountConditions: string[] = [];

    if (options?.merchantId) {
      accountParams.push(options.merchantId);
      accountConditions.push(`a.merchant_id = $${accountParams.length}`);
    }

    if (options?.accountId) {
      accountParams.push(options.accountId);
      accountConditions.push(`a.id = $${accountParams.length}`);
    }

    const accountWhere =
      accountConditions.length > 0 ? `WHERE ${accountConditions.join(' AND ')}` : '';

    // 1. Audit Stored Balance vs Calculated Balance from Ledger Entries
    const checkQuery = `
      SELECT 
        a.id AS account_id,
        a.merchant_id,
        a.owner_name,
        a.balance_paise AS stored_balance_paise,
        COALESCE(SUM(
          CASE 
            WHEN le.entry_type = 'CREDIT' THEN le.amount
            WHEN le.entry_type = 'DEBIT' THEN -le.amount
            ELSE 0
          END
        ), 0)::NUMERIC AS calculated_balance_paise,
        (a.balance_paise - COALESCE(SUM(
          CASE 
            WHEN le.entry_type = 'CREDIT' THEN le.amount
            WHEN le.entry_type = 'DEBIT' THEN -le.amount
            ELSE 0
          END
        ), 0))::NUMERIC AS discrepancy_paise
      FROM accounts a
      LEFT JOIN ledger_entries le ON a.id = le.account_id
      ${accountWhere}
      GROUP BY a.id, a.merchant_id, a.owner_name, a.balance_paise
      HAVING a.balance_paise != COALESCE(SUM(
        CASE 
          WHEN le.entry_type = 'CREDIT' THEN le.amount
          WHEN le.entry_type = 'DEBIT' THEN -le.amount
          ELSE 0
        END
      ), 0)::NUMERIC;
    `;

    // 2. Count total accounts checked
    const countQuery = `SELECT COUNT(*)::INT AS total FROM accounts a ${accountWhere};`;

    // Build transaction scoping
    // We select all transaction IDs where at least one entry touches the requested merchant or account,
    // and then evaluate all legs of those transactions together to avoid false imbalances.
    const txScopeParams: any[] = [];
    let txScopeWhere = '';

    if (options?.merchantId || options?.accountId) {
      const scopeConditions: string[] = [];
      if (options?.merchantId) {
        txScopeParams.push(options.merchantId);
        scopeConditions.push(`a_scope.merchant_id = $${txScopeParams.length}`);
      }
      if (options?.accountId) {
        txScopeParams.push(options.accountId);
        scopeConditions.push(`a_scope.id = $${txScopeParams.length}`);
      }
      txScopeWhere = `WHERE le.transaction_id IN (
        SELECT le_scope.transaction_id
        FROM ledger_entries le_scope
        JOIN accounts a_scope ON le_scope.account_id = a_scope.id
        WHERE ${scopeConditions.join(' AND ')}
      )`;
    }

    // 3. Overall double-entry conservation invariant
    const conservationQuery = `
      SELECT COALESCE(
        SUM(CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE 0 END) -
        SUM(CASE WHEN le.entry_type = 'CREDIT' AND le.transaction_id IN (
          SELECT sub.transaction_id FROM ledger_entries sub WHERE sub.entry_type = 'DEBIT'
        ) THEN le.amount ELSE 0 END), 0
      )::NUMERIC AS net_discrepancy_paise
      FROM ledger_entries le
      ${txScopeWhere};
    `;

    // 4. Detect Unbalanced Transfers (sum(debit) != sum(credit))
    const unbalancedTxQuery = `
      SELECT 
        le.transaction_id,
        COALESCE(SUM(CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE 0 END), 0)::NUMERIC AS debit_total,
        COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE 0 END), 0)::NUMERIC AS credit_total,
        COALESCE(
          SUM(CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE 0 END) -
          SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE 0 END), 0
        )::NUMERIC AS imbalance_paise,
        ARRAY_AGG(DISTINCT le.account_id::TEXT) AS affected_accounts
      FROM ledger_entries le
      ${txScopeWhere}
      GROUP BY le.transaction_id
      HAVING COUNT(*) > 1 AND (
        SUM(CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE 0 END) !=
        SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE 0 END)
      );
    `;

    // 5. Detect Missing Counterparts in Transfers
    // Case A: Has DEBIT but 0 CREDITs (orphaned debit leg)
    // Case B: Has multiple entries, has CREDITs but 0 DEBITs (orphaned credit leg)
    const missingCounterpartQuery = `
      SELECT 
        le.transaction_id,
        COUNT(CASE WHEN le.entry_type = 'DEBIT' THEN 1 END)::INT AS debit_count,
        COUNT(CASE WHEN le.entry_type = 'CREDIT' THEN 1 END)::INT AS credit_count,
        COALESCE(SUM(CASE WHEN le.entry_type = 'DEBIT' THEN le.amount ELSE 0 END), 0)::NUMERIC AS debit_total,
        COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE 0 END), 0)::NUMERIC AS credit_total,
        ARRAY_AGG(DISTINCT le.account_id::TEXT) AS affected_accounts
      FROM ledger_entries le
      ${txScopeWhere}
      GROUP BY le.transaction_id
      HAVING 
        (COUNT(CASE WHEN le.entry_type = 'DEBIT' THEN 1 END) > 0 AND COUNT(CASE WHEN le.entry_type = 'CREDIT' THEN 1 END) = 0)
        OR
        (COUNT(CASE WHEN le.entry_type = 'DEBIT' THEN 1 END) = 0 AND COUNT(CASE WHEN le.entry_type = 'CREDIT' THEN 1 END) > 1);
    `;

    // 6. Detect Duplicated Entries for Same Account in Single Transaction
    const duplicateEntriesQuery = `
      SELECT 
        le.transaction_id,
        le.account_id,
        COUNT(*)::INT AS entry_count,
        ARRAY_AGG(le.entry_type) AS entry_types,
        ARRAY_AGG(le.amount::TEXT) AS amounts
      FROM ledger_entries le
      ${txScopeWhere}
      GROUP BY le.transaction_id, le.account_id
      HAVING COUNT(*) > 1;
    `;

    // 7. Detect Malformed Records
    // (amount <= 0, > MAX_SAFE_PAISE, invalid entry_type, or orphaned account)
    let malformedWhere = `
      WHERE (
        a.id IS NULL 
        OR le.amount <= 0 
        OR le.amount > ${MAX_SAFE_PAISE} 
        OR le.entry_type NOT IN ('DEBIT', 'CREDIT')
      )
    `;
    const malformedParams: any[] = [];
    if (options?.merchantId) {
      malformedParams.push(options.merchantId);
      malformedWhere += ` AND (a.merchant_id = $${malformedParams.length} OR a.id IS NULL)`;
    }
    if (options?.accountId) {
      malformedParams.push(options.accountId);
      malformedWhere += ` AND (le.account_id = $${malformedParams.length})`;
    }

    const malformedRecordsQuery = `
      SELECT 
        le.id,
        le.transaction_id,
        le.account_id,
        le.entry_type,
        le.amount::TEXT,
        CASE
          WHEN a.id IS NULL THEN 'ORPHANED_ACCOUNT'
          WHEN le.amount <= 0 THEN 'NON_POSITIVE_AMOUNT'
          WHEN le.amount > ${MAX_SAFE_PAISE} THEN 'EXCEEDS_MAX_SAFE_PAISE'
          WHEN le.entry_type NOT IN ('DEBIT', 'CREDIT') THEN 'INVALID_ENTRY_TYPE'
          ELSE 'UNKNOWN_ANOMALY'
        END AS anomaly_reason
      FROM ledger_entries le
      LEFT JOIN accounts a ON le.account_id = a.id
      ${malformedWhere};
    `;

    // 8. Detect Cross-Tenant Leakage (transfer linking accounts of different merchants)
    const crossTenantQuery = `
      SELECT 
        le.transaction_id,
        COUNT(DISTINCT a.merchant_id)::INT AS distinct_merchants,
        ARRAY_AGG(DISTINCT a.merchant_id::TEXT) AS merchant_ids,
        ARRAY_AGG(DISTINCT le.account_id::TEXT) AS affected_accounts
      FROM ledger_entries le
      JOIN accounts a ON le.account_id = a.id
      ${txScopeWhere}
      GROUP BY le.transaction_id
      HAVING COUNT(DISTINCT a.merchant_id) > 1;
    `;

    // 9. Count total transactions checked
    const txCountQuery = `
      SELECT COUNT(DISTINCT le.transaction_id)::INT AS total
      FROM ledger_entries le
      ${txScopeWhere};
    `;

    // Execute queries sequentially inside the snapshot session to avoid pg query pipelining warnings
    const discrepanciesRes = await client.query(checkQuery, accountParams);
    const countRes = await client.query(countQuery, accountParams);
    const conservationRes = await client.query(conservationQuery, txScopeParams);
    const unbalancedRes = await client.query(unbalancedTxQuery, txScopeParams);
    const missingCounterpartRes = await client.query(missingCounterpartQuery, txScopeParams);
    const duplicateRes = await client.query(duplicateEntriesQuery, txScopeParams);
    const malformedRes = await client.query(malformedRecordsQuery, malformedParams);
    const crossTenantRes = await client.query(crossTenantQuery, txScopeParams);
    const txCountRes = await client.query(txCountQuery, txScopeParams);

    // Commit snapshot transaction cleanly
    await client.query('COMMIT');

    const totalAccountsChecked = countRes.rows[0]?.total || 0;
    const totalTransactionsChecked = txCountRes.rows[0]?.total || 0;
    const netDiscrepancyBigInt = BigInt(conservationRes.rows[0]?.net_discrepancy_paise || 0);
    const netDiscrepancy = Number(netDiscrepancyBigInt);

    // Format account balance discrepancies
    const discrepancies: AccountDiscrepancy[] = discrepanciesRes.rows.map((r) => {
      const stored = Number(BigInt(r.stored_balance_paise));
      const calculated = Number(BigInt(r.calculated_balance_paise));
      const discrepancy = Number(BigInt(r.discrepancy_paise));
      return {
        account_id: r.account_id,
        merchant_id: r.merchant_id,
        owner_name: r.owner_name,
        stored_balance_paise: stored,
        calculated_balance_paise: calculated,
        cached_balance_paise: stored, // Backwards compatibility
        computed_balance_paise: calculated, // Backwards compatibility
        discrepancy_paise: discrepancy,
        status: 'BALANCE_MISMATCH',
      };
    });

    // Format transaction integrity violations
    const integrityViolations: TransactionIntegrityViolation[] = [];

    // Unbalanced transfers
    for (const row of unbalancedRes.rows) {
      integrityViolations.push({
        transaction_id: row.transaction_id,
        violation_type: 'UNBALANCED_TRANSFER',
        details: `Transfer debits (${row.debit_total} paise) do not equal credits (${row.credit_total} paise). Net imbalance: ${row.imbalance_paise} paise.`,
        debit_paise: Number(BigInt(row.debit_total)),
        credit_paise: Number(BigInt(row.credit_total)),
        imbalance_paise: Number(BigInt(row.imbalance_paise)),
        affected_accounts: row.affected_accounts || [],
      });
    }

    // Missing counterparts
    for (const row of missingCounterpartRes.rows) {
      integrityViolations.push({
        transaction_id: row.transaction_id,
        violation_type: 'MISSING_COUNTERPART',
        details: `Transfer has ${row.debit_count} DEBITs and ${row.credit_count} CREDITs. Missing opposite entry leg.`,
        debit_paise: Number(BigInt(row.debit_total)),
        credit_paise: Number(BigInt(row.credit_total)),
        imbalance_paise: Number(BigInt(row.debit_total) - BigInt(row.credit_total)),
        affected_accounts: row.affected_accounts || [],
      });
    }

    // Duplicate entries
    for (const row of duplicateRes.rows) {
      integrityViolations.push({
        transaction_id: row.transaction_id,
        violation_type: 'DUPLICATE_ENTRIES',
        details: `Account ${row.account_id} has ${row.entry_count} duplicate entries (${row.entry_types.join(', ')}) under the same transaction ID.`,
        debit_paise: 0,
        credit_paise: 0,
        imbalance_paise: 0,
        affected_accounts: [row.account_id],
      });
    }

    // Malformed records
    for (const row of malformedRes.rows) {
      integrityViolations.push({
        transaction_id: row.transaction_id,
        violation_type: 'MALFORMED_RECORD',
        details: `Ledger entry ${row.id} violates schema invariants: ${row.anomaly_reason} (amount=${row.amount}, entry_type=${row.entry_type}).`,
        debit_paise: row.entry_type === 'DEBIT' ? Number(row.amount) : 0,
        credit_paise: row.entry_type === 'CREDIT' ? Number(row.amount) : 0,
        imbalance_paise: Number(row.amount),
        affected_accounts: row.account_id ? [row.account_id] : [],
      });
    }

    // Cross-tenant leakage
    for (const row of crossTenantRes.rows) {
      integrityViolations.push({
        transaction_id: row.transaction_id,
        violation_type: 'CROSS_TENANT_LEAKAGE',
        details: `Transaction spans ${row.distinct_merchants} distinct merchants: ${row.merchant_ids.join(', ')}.`,
        debit_paise: 0,
        credit_paise: 0,
        imbalance_paise: 0,
        affected_accounts: row.affected_accounts || [],
      });
    }

    // Explicit manual repair ONLY if explicitly requested (never automatic or silent)
    if (options?.autoRepair && discrepancies.length > 0) {
      for (const d of discrepancies) {
        await query(
          `UPDATE accounts SET balance_paise = $1 WHERE id = $2`,
          [d.calculated_balance_paise, d.account_id]
        );
        logger.warn(
          {
            account_id: d.account_id,
            old_balance: d.stored_balance_paise,
            repaired_balance: d.calculated_balance_paise,
          },
          '[Reconciliation] Explicitly repaired account balance to match ledger SUM'
        );
      }
    }

    const isHealthy =
      discrepancies.length === 0 &&
      integrityViolations.length === 0 &&
      netDiscrepancyBigInt === 0n;

    return {
      timestamp: new Date().toISOString(),
      total_accounts_checked: totalAccountsChecked,
      total_transactions_checked: totalTransactionsChecked,
      discrepancies_found: discrepancies.length,
      integrity_violations_found: integrityViolations.length,
      discrepancies,
      integrity_violations: integrityViolations,
      double_entry_net_discrepancy_paise: netDiscrepancy,
      status: isHealthy ? 'HEALTHY' : 'DISCREPANCY_DETECTED',
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}
