export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('direct','group')),
  title text NOT NULL DEFAULT '',
  owner_id text NOT NULL REFERENCES users(id),
  direct_key text UNIQUE,
  last_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id, active);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  sender_id text NOT NULL REFERENCES users(id),
  request_id text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, sender_id, request_id)
);
CREATE INDEX IF NOT EXISTS messages_history_idx ON messages(conversation_id, sequence);
CREATE TABLE IF NOT EXISTS send_requests (
  conversation_id text NOT NULL,
  sender_id text NOT NULL REFERENCES users(id),
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','saved','rejected')),
  message_id text REFERENCES messages(id),
  reason text,
  PRIMARY KEY (conversation_id, sender_id, request_id)
);
CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  room text NOT NULL,
  event jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_claim_idx ON outbox(available_at, created_at) WHERE completed_at IS NULL;
CREATE TABLE IF NOT EXISTS device_positions (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id, conversation_id)
);
`;
