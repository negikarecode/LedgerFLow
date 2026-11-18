-- Migration 009: Financial Invariants and Safe Integer Bounds
-- Enforces application safe integer ceiling (Number.MAX_SAFE_INTEGER = 9007199254740991)
-- on accounts.balance_paise and ledger_entries.amount at the database level.

DO $$
BEGIN
    -- 1. Ensure accounts.balance_paise does not exceed Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_balance_max_safe'
    ) THEN
        ALTER TABLE accounts 
        ADD CONSTRAINT chk_accounts_balance_max_safe 
        CHECK (balance_paise <= 9007199254740991);
    END IF;

    -- 2. Ensure ledger_entries.amount does not exceed Number.MAX_SAFE_INTEGER (9,007,199,254,740,991)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_ledger_entries_amount_max_safe'
    ) THEN
        ALTER TABLE ledger_entries 
        ADD CONSTRAINT chk_ledger_entries_amount_max_safe 
        CHECK (amount <= 9007199254740991);
    END IF;
END $$;
