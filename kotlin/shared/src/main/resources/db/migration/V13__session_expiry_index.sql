CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
