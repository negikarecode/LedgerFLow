# LedgerFlow Reconciliation & Financial Integrity Architecture

## 1. Executive Summary

LedgerFlow implements an independent, read-only reconciliation and audit engine designed to verify financial accounting invariants, detect ledger anomalies, and guarantee balance conservation across all accounts and transactions.

The engine executes in strict point-in-time snapshot isolation, immunizing the audit against race conditions caused by concurrent, in-flight transfers. It never silently or automatically alters financial records, preserving the immutable double-entry ledger history required for regulatory compliance and auditability.

---

## 2. Core Architectural Guarantees

1. **Independent Balance Derivation**: Stored account balances (`accounts.balance_paise`) are independently verified against the mathematical sum of all historical immutable entries (`ledger_entries`):
   $$\text{Calculated Balance} = \sum_{\text{entry} \in \text{CREDIT}} \text{amount} - \sum_{\text{entry} \in \text{DEBIT}} \text{amount}$$
2. **Double-Entry Conservation**: Every financial transfer must conserve value across debit and credit legs:
   $$\sum \text{DEBIT} = \sum \text{CREDIT}$$
3. **Point-in-Time Snapshot Isolation**: All reconciliation queries execute inside a dedicated PostgreSQL session configured with:
   ```sql
   BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
   ```
   This ensures that concurrent transactions committing mid-reconciliation do not introduce phantom imbalances or false discrepancies.
4. **Strictly Read-Only by Default**: Reconciliation is authoritative and purely observational. It will never silently alter account balances or delete ledger entries.
5. **Secure Multi-Tenant Scoping**: Audits can run globally across the platform, or scoped securely by `merchant_id` (tenant) and/or `account_id`.
6. **Data Privacy**: Audit reports expose solely identifiers, calculated vs. stored amounts in integer paise, and discrepancy deltas. No API credentials, secrets, or PII are exposed.

---

## 3. Discrepancy Taxonomy

The reconciliation engine flags six distinct categories of financial integrity violations:

| Violation Code | Severity | Description | Trigger Condition |
| :--- | :--- | :--- | :--- |
| `BALANCE_MISMATCH` | **CRITICAL** | Stored account cached balance diverges from ledger entries. | `accounts.balance_paise != SUM(ledger_entries)` |
| `UNBALANCED_TRANSFER` | **CRITICAL** | A transfer transaction does not conserve value. | `SUM(DEBIT) != SUM(CREDIT)` for a `transaction_id` |
| `MISSING_COUNTERPART` | **CRITICAL** | A transaction has a debit without credit or credit without debit. | `DEBIT > 0 AND CREDIT = 0`, or `DEBIT = 0 AND CREDIT > 1` |
| `DUPLICATE_ENTRIES` | **HIGH** | The same account appears multiple times in one transaction. | `COUNT(*) > 1` for `(transaction_id, account_id)` |
| `MALFORMED_RECORD` | **CRITICAL** | A ledger entry violates accounting domain invariants. | `amount <= 0`, `amount > MAX_SAFE_PAISE`, invalid `entry_type`, or orphaned `account_id` |
| `CROSS_TENANT_LEAKAGE` | **CRITICAL** | A transaction links accounts owned by distinct merchants. | `COUNT(DISTINCT accounts.merchant_id) > 1` |

---

## 4. API Specification

### Endpoint: `POST /admin/reconcile`

Triggers an on-demand reconciliation run. Protected by `ADMIN_TOKEN`.

#### Request Headers
```http
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

#### Request Body (Optional)
```json
{
  "merchant_id": "00000000-0000-0000-0000-000000000001",
  "account_id": "a1b2c3d4-0000-0000-0000-000000000001",
  "auto_repair": false
}
```

- `merchant_id` *(UUID string, optional)*: Restricts audit to accounts and transactions involving this merchant.
- `account_id` *(UUID string, optional)*: Restricts audit to this specific account.
- `auto_repair` *(boolean, default: false)*: When `false`, the operation is purely read-only. Manual repair should only be executed under emergency operator supervision.

#### Response: Healthy Example (`200 OK`)
```json
{
  "timestamp": "2026-11-18T12:05:00.000Z",
  "total_accounts_checked": 42,
  "total_transactions_checked": 1500,
  "discrepancies_found": 0,
  "integrity_violations_found": 0,
  "discrepancies": [],
  "integrity_violations": [],
  "double_entry_net_discrepancy_paise": 0,
  "status": "HEALTHY"
}
```

#### Response: Discrepancy Detected Example (`200 OK`)
```json
{
  "timestamp": "2026-11-18T12:05:00.000Z",
  "total_accounts_checked": 42,
  "total_transactions_checked": 1500,
  "discrepancies_found": 1,
  "integrity_violations_found": 1,
  "discrepancies": [
    {
      "account_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "merchant_id": "00000000-0000-0000-0000-000000000001",
      "owner_name": "Acme Corp Reserve",
      "stored_balance_paise": 1050000,
      "calculated_balance_paise": 1000000,
      "discrepancy_paise": 50000,
      "status": "BALANCE_MISMATCH"
    }
  ],
  "integrity_violations": [
    {
      "transaction_id": "f9e8d7c6-b5a4-3210-fedc-ba9876543210",
      "violation_type": "UNBALANCED_TRANSFER",
      "details": "Transfer debits (100000 paise) do not equal credits (50000 paise). Net imbalance: 50000 paise.",
      "debit_paise": 100000,
      "credit_paise": 50000,
      "imbalance_paise": 50000,
      "affected_accounts": [
        "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "b2c3d4e5-f6a7-8901-bcde-f12345678901"
      ]
    }
  ],
  "double_entry_net_discrepancy_paise": 50000,
  "status": "DISCREPANCY_DETECTED"
}
```

---

## 5. Operator Runbook & Incident Investigation

When the reconciliation system reports `status: "DISCREPANCY_DETECTED"`, operators must follow this step-by-step triage protocol.

### Step 1: Isolate the Incident
Identify the scope of the anomaly:
1. Note the `merchant_id`, `account_id`, and `transaction_id` from the alert.
2. Re-run reconciliation specifically for that merchant or account to isolate the timeline:
   ```bash
   curl -X POST https://api.ledgerflow.internal/admin/reconcile \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"merchant_id": "<MERCHANT_ID>", "account_id": "<ACCOUNT_ID>"}'
   ```

### Step 2: Diagnostic SQL Queries

Connect to the PostgreSQL read replica or primary instance and execute the appropriate diagnostic query:

#### A. Investigate Account Balance Mismatch (`BALANCE_MISMATCH`)
```sql
-- Audit full history of ledger entries for the affected account
SELECT 
  le.id,
  le.transaction_id,
  le.entry_type,
  le.amount,
  le.created_at,
  SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE -le.amount END) 
    OVER (ORDER BY le.created_at, le.id) AS running_balance
FROM ledger_entries le
WHERE le.account_id = '<ACCOUNT_ID>'
ORDER BY le.created_at ASC;

-- Compare against stored cached balance
SELECT id, owner_name, balance_paise, created_at 
FROM accounts 
WHERE id = '<ACCOUNT_ID>';
```

#### B. Investigate Unbalanced or Orphaned Transfers (`UNBALANCED_TRANSFER` / `MISSING_COUNTERPART`)
```sql
-- Inspect all legs of the offending transaction
SELECT 
  le.id,
  le.transaction_id,
  le.account_id,
  a.owner_name,
  a.merchant_id,
  le.entry_type,
  le.amount,
  le.created_at
FROM ledger_entries le
JOIN accounts a ON le.account_id = a.id
WHERE le.transaction_id = '<TRANSACTION_ID>';

-- Cross-reference with the Transactional Outbox
SELECT id, event_type, payload, status, attempts, created_at
FROM outbox_events
WHERE (payload->>'transfer_id')::TEXT = '<TRANSACTION_ID>';
```

#### C. Investigate Cross-Tenant Leakage (`CROSS_TENANT_LEAKAGE`)
```sql
SELECT 
  le.id,
  le.transaction_id,
  le.account_id,
  a.merchant_id,
  m.name AS merchant_name,
  le.entry_type,
  le.amount
FROM ledger_entries le
JOIN accounts a ON le.account_id = a.id
JOIN merchants m ON a.merchant_id = m.id
WHERE le.transaction_id = '<TRANSACTION_ID>';
```

---

## 6. Remediation Policy: Compensating Journal Entries

> [!CAUTION]
> **NEVER MANUALLY UPDATE BALANCES OR DELETE LEDGER ENTRIES DIRECTLY VIA SQL `UPDATE` OR `DELETE`.**
> Directly altering `accounts.balance_paise` or deleting rows from `ledger_entries` destroys audit trails and creates unverifiable financial gaps.

All corrections must follow the **Double-Entry Correction Protocol**:

1. **Calculate the Exact Variance**:
   Determine whether the account was credited or debited incorrectly, and determine the offsetting reserve account (e.g. `Suspense/Discrepancy Account`).
2. **Issue a Compensating Transaction**:
   Create a corrective ledger transaction with two balanced entries:
   - One entry on the affected account with type `CREDIT` or `DEBIT` for the exact difference.
   - One counterbalancing entry on the company's designated internal reconciliation account.
3. **Update Stored Balance**:
   Execute the update within the transaction:
   ```sql
   BEGIN;
   -- 1. Insert compensating journal entries
   INSERT INTO ledger_entries (id, transaction_id, account_id, entry_type, amount)
   VALUES 
     (gen_random_uuid(), '<CORRECTION_TX_ID>', '<AFFECTED_ACCOUNT_ID>', 'CREDIT', <DELTA_PAISE>),
     (gen_random_uuid(), '<CORRECTION_TX_ID>', '<INTERNAL_SUSPENSE_ACCOUNT_ID>', 'DEBIT', <DELTA_PAISE>);

   -- 2. Update cached balance with row lock
   UPDATE accounts 
   SET balance_paise = balance_paise + <DELTA_PAISE> 
   WHERE id = '<AFFECTED_ACCOUNT_ID>';

   UPDATE accounts 
   SET balance_paise = balance_paise - <DELTA_PAISE> 
   WHERE id = '<INTERNAL_SUSPENSE_ACCOUNT_ID>';

   COMMIT;
   ```
4. **Re-run Verification**:
   Trigger `POST /admin/reconcile` and verify the status returns to `HEALTHY`.

---

## 7. System Guarantees & Known Limitations

### Guarantees
- **No Lock Contention**: The reconciliation process runs in `READ ONLY` mode without taking `FOR UPDATE` row locks or table locks, allowing financial transactions to proceed concurrently without blocking or degradation.
- **Repeatable Read Snapshot**: Snapshot isolation ensures that transfers committing during a multi-second reconciliation do not cause false alarms.
- **Safe Integer Bounds**: Detects values exceeding `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 paise) to prevent precision degradation in Node.js runtimes.

### Limitations
- **Read Replica Lag**: If reconciliation is pointed at an asynchronous read replica rather than the primary database, replication lag may cause recent transactions (within the lag window) to be omitted from the snapshot. In production environments requiring zero lag, point reconciliation queries to the primary database.
- **High Data Volume Scaling**: On datasets exceeding tens of millions of ledger entries, full table scans for unscoped platform-wide reconciliations will require scheduled execution during low-traffic maintenance windows, or partitioning `ledger_entries` by `created_at` / `merchant_id`.
