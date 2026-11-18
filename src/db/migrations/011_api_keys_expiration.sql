-- Migration 011: Add optional expires_at column to api_keys
ALTER TABLE api_keys 
ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys(expires_at);
