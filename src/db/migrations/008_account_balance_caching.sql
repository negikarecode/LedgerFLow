-- Migration 008: Account Balance Caching & Performance Optimization
-- Adds balance_paise column to accounts updated under existing row locks,
-- enforced by a CHECK constraint (balance_paise >= 0) to prevent overdrafts at DB level.

-- 1. Add balance_paise column to accounts
ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS balance_paise BIGINT NOT NULL DEFAULT 0;

-- 2. Backfill cached balance_paise from existing immutable ledger_entries
UPDATE accounts a
SET balance_paise = COALESCE((
    SELECT SUM(
        CASE 
            WHEN le.entry_type = 'CREDIT' THEN le.amount
            WHEN le.entry_type = 'DEBIT' THEN -le.amount
            ELSE 0
        END
    )
    FROM ledger_entries le
    WHERE le.account_id = a.id
), 0);

-- 3. Add CHECK constraint preventing negative balance at database level
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_balance_non_negative'
    ) THEN
        ALTER TABLE accounts 
        ADD CONSTRAINT chk_accounts_balance_non_negative CHECK (balance_paise >= 0);
    END IF;
END $$;

-- 4. Index for outbox poller optimization (status, next_retry_at, created_at)
CREATE INDEX IF NOT EXISTS idx_outbox_events_pending_polling 
ON outbox_events(status, next_retry_at, created_at) 
WHERE status = 'PENDING';
