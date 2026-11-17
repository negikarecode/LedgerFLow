-- Migration 006: Endpoint Isolation, Circuit Breaker State & Rate Limiting

ALTER TABLE webhook_endpoints
ADD COLUMN IF NOT EXISTS circuit_breaker_state VARCHAR(20) NOT NULL DEFAULT 'CLOSED',
ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS cb_opened_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS cb_last_failure_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS rate_limit_per_second INT NOT NULL DEFAULT 10,
ADD COLUMN IF NOT EXISTS rate_limit_burst INT NOT NULL DEFAULT 20;

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_cb_state 
ON webhook_endpoints(circuit_breaker_state);
