ALTER TABLE sessions
    ADD COLUMN last_used_at timestamptz,
    ADD COLUMN device_label varchar(64);
UPDATE sessions SET last_used_at = created_at, device_label = 'Unknown device';
ALTER TABLE sessions
    ALTER COLUMN last_used_at SET DEFAULT now(),
    ALTER COLUMN last_used_at SET NOT NULL,
    ALTER COLUMN device_label SET DEFAULT 'Unknown device',
    ALTER COLUMN device_label SET NOT NULL,
    ADD CONSTRAINT sessions_device_label_present CHECK (length(device_label) > 0);

CREATE TABLE login_throttles (
    throttle_key varchar(128) PRIMARY KEY,
    attempt_count integer NOT NULL CHECK (attempt_count >= 0),
    last_attempt_at timestamptz NOT NULL,
    blocked_until timestamptz NOT NULL
);
CREATE INDEX login_throttles_last_attempt_idx ON login_throttles(last_attempt_at);
