CREATE TABLE users (
    id varchar(26) PRIMARY KEY,
    username varchar(40) NOT NULL,
    password_hash varchar(100) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_unique UNIQUE (username)
);
CREATE TABLE sessions (
    token_hash char(64) PRIMARY KEY,
    user_id varchar(26) NOT NULL REFERENCES users(id),
    device_id varchar(64) NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE conversations (
    id varchar(26) PRIMARY KEY,
    kind varchar(8) NOT NULL CHECK (kind IN ('direct','group')),
    name varchar(80),
    direct_pair_key varchar(53) UNIQUE,
    next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT conversations_kind_shape CHECK (
        (kind='direct' AND name IS NULL AND direct_pair_key IS NOT NULL) OR
        (kind='group' AND name IS NOT NULL AND direct_pair_key IS NULL)
    )
);
CREATE TABLE conversation_members (
    conversation_id varchar(26) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id varchar(26) NOT NULL REFERENCES users(id),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id,user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members(user_id,conversation_id);
CREATE TABLE send_requests (
    conversation_id varchar(26) NOT NULL,
    sender_id varchar(26) NOT NULL,
    request_id varchar(26) NOT NULL,
    fingerprint char(64) NOT NULL,
    status varchar(8) NOT NULL CHECK (status IN ('saved','rejected')),
    message_id varchar(26),
    sequence bigint,
    reason varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id,sender_id,request_id),
    CONSTRAINT send_requests_result_shape CHECK (
        (status='saved' AND message_id IS NOT NULL AND sequence IS NOT NULL AND reason IS NULL) OR
        (status='rejected' AND message_id IS NULL AND sequence IS NULL AND reason IS NOT NULL)
    )
);
CREATE TABLE messages (
    id varchar(26) PRIMARY KEY,
    conversation_id varchar(26) NOT NULL REFERENCES conversations(id),
    sequence bigint NOT NULL CHECK (sequence > 0),
    sender_id varchar(26) NOT NULL REFERENCES users(id),
    body varchar(4000) NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
    created_at timestamptz NOT NULL,
    CONSTRAINT messages_conversation_sequence_unique UNIQUE (conversation_id,sequence)
);
CREATE INDEX messages_history_idx ON messages(conversation_id,sequence);
CREATE TABLE outbox_events (
    id varchar(26) PRIMARY KEY,
    room varchar(96) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    lease_owner varchar(64),
    lease_until timestamptz,
    published_at timestamptz,
    attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(created_at,id) WHERE published_at IS NULL;
