-- LedgerFlow Phase 5 Migration: Merchants, API Keys, and Multi-Tenancy (002_merchants_and_api_keys.sql)

-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. API Keys Table
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_merchant_id ON api_keys(merchant_id);

-- 3. Seed Default Demo Merchant & Fixed Demo API Key
-- Full demo key: lf_live_demo_key_for_chaos_simulator_1234567890
-- SHA-256 of 'lf_live_demo_key_for_chaos_simulator_1234567890':
-- '8744047e1329a43a08c0ea01d2d66579dd1ce1062953e5e40e21ca663d80362f'
INSERT INTO merchants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Demo Merchant')
ON CONFLICT (id) DO NOTHING;

INSERT INTO api_keys (id, merchant_id, key_prefix, key_hash)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'lf_live_demo_key',
    'c493db595f469fe025715057076dd17b8c4c8b80f596988553641df7d04a33be'
)
ON CONFLICT (id) DO NOTHING;

-- 4. Add merchant_id to accounts
ALTER TABLE accounts 
ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE;

UPDATE accounts 
SET merchant_id = '00000000-0000-0000-0000-000000000001' 
WHERE merchant_id IS NULL;

ALTER TABLE accounts 
ALTER COLUMN merchant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_merchant_id ON accounts(merchant_id);

-- 5. Add merchant_id to outbox_events
ALTER TABLE outbox_events 
ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE;

UPDATE outbox_events 
SET merchant_id = '00000000-0000-0000-0000-000000000001' 
WHERE merchant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_events_merchant_id ON outbox_events(merchant_id);

-- 6. Namespace idempotency_keys by merchant_id
ALTER TABLE idempotency_keys 
ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE;

UPDATE idempotency_keys 
SET merchant_id = '00000000-0000-0000-0000-000000000001' 
WHERE merchant_id IS NULL;

-- Drop old single-column primary key constraint and create composite primary key (merchant_id, key)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'idempotency_keys_merchant_key_pkey' 
        AND table_name = 'idempotency_keys'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'idempotency_keys_pkey' 
            AND table_name = 'idempotency_keys'
        ) THEN
            ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
        END IF;

        ALTER TABLE idempotency_keys 
        ADD CONSTRAINT idempotency_keys_merchant_key_pkey PRIMARY KEY (merchant_id, key);
    END IF;
END $$;
