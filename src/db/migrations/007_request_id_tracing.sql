-- Migration 007: Request ID Distributed Tracing

ALTER TABLE outbox_events
ADD COLUMN IF NOT EXISTS request_id VARCHAR(255);

ALTER TABLE delivery_attempts
ADD COLUMN IF NOT EXISTS request_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_outbox_events_request_id ON outbox_events(request_id);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_request_id ON delivery_attempts(request_id);
