-- LedgerFlow Idempotency Hardening Migration (004_idempotency_hardening.sql)

-- 1. Ensure composite unique constraint on (merchant_id, key)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'uq_idempotency_keys_merchant_key' 
        AND table_name = 'idempotency_keys'
    ) THEN
        ALTER TABLE idempotency_keys 
        ADD CONSTRAINT uq_idempotency_keys_merchant_key UNIQUE (merchant_id, key);
    END IF;
END $$;

-- 2. Indexes for efficient TTL cleanup and inspection
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_merchant_created ON idempotency_keys(merchant_id, created_at);
