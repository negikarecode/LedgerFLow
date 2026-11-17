-- Migration 003: Registered Webhook Endpoints & Per-Endpoint Signing Secrets

-- 1. Create webhook_endpoints table
CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    url VARCHAR(2048) NOT NULL,
    secret VARCHAR(255) NOT NULL,
    event_types TEXT[] NOT NULL DEFAULT ARRAY['transfer.completed']::TEXT[],
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup of active endpoints by merchant
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_merchant_status 
ON webhook_endpoints(merchant_id, status);

-- 2. Add endpoint_id reference to outbox_events
ALTER TABLE outbox_events
ADD COLUMN IF NOT EXISTS endpoint_id UUID REFERENCES webhook_endpoints(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbox_events_endpoint_id 
ON outbox_events(endpoint_id);

-- 3. Seed default demo endpoint for DEFAULT_DEMO_MERCHANT_ID (00000000-0000-0000-0000-000000000001)
-- Uses default secret 'default-ledgerflow-secret-key-12345' matching WEBHOOK_SECRET
INSERT INTO webhook_endpoints (id, merchant_id, url, secret, event_types, status)
VALUES (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'http://127.0.0.1:3000/mock-merchant/webhook',
    'default-ledgerflow-secret-key-12345',
    ARRAY['transfer.completed']::TEXT[],
    'ACTIVE'
)
ON CONFLICT (id) DO NOTHING;
