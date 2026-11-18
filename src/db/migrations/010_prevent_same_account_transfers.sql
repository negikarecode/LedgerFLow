-- Migration 010: Prevent Same-Account Transfers Invariant
-- Ensures a single transaction_id cannot have multiple ledger entries for the same account_id,
-- preventing self-transfers (same source and destination) at the database engine level.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_ledger_entries_transaction_account'
    ) THEN
        ALTER TABLE ledger_entries 
        ADD CONSTRAINT uq_ledger_entries_transaction_account 
        UNIQUE (transaction_id, account_id);
    END IF;
END $$;
