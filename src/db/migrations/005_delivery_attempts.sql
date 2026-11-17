-- LedgerFlow Migration: Delivery Attempts Log (005_delivery_attempts.sql)

CREATE TABLE IF NOT EXISTS delivery_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_event_id UUID NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
    attempt_number INT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    duration_ms INT NOT NULL,
    http_status INT,
    error_message TEXT,
    request_signature TEXT NOT NULL,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_outbox_event_id ON delivery_attempts(outbox_event_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_created_at ON delivery_attempts(created_at);
