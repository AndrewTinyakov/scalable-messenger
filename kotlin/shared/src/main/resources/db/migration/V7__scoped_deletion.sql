ALTER TABLE chats
    ADD COLUMN cleared_through_sequence bigint NOT NULL DEFAULT 0 CHECK (cleared_through_sequence >= 0),
    ADD COLUMN purged_through_sequence bigint NOT NULL DEFAULT 0 CHECK (purged_through_sequence >= 0),
    ADD COLUMN purged_rows bigint NOT NULL DEFAULT 0 CHECK (purged_rows >= 0);

ALTER TABLE chat_members
    ADD COLUMN cleared_through_sequence bigint NOT NULL DEFAULT 0 CHECK (cleared_through_sequence >= 0),
    ADD COLUMN hidden_through_sequence bigint CHECK (hidden_through_sequence >= 0),
    ADD COLUMN visibility_revision bigint NOT NULL DEFAULT 0 CHECK (visibility_revision >= 0);

CREATE TABLE hidden_message_ranges (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    user_id varchar(26) NOT NULL REFERENCES users(id),
    after_sequence bigint NOT NULL CHECK (after_sequence >= 0),
    through_sequence bigint NOT NULL CHECK (through_sequence > after_sequence),
    PRIMARY KEY (chat_id, user_id, after_sequence)
);
CREATE INDEX hidden_message_ranges_reverse_idx ON hidden_message_ranges(chat_id, user_id, through_sequence);
CREATE INDEX hidden_message_ranges_cleanup_idx ON hidden_message_ranges(chat_id, through_sequence, user_id, after_sequence);

ALTER TABLE messages DROP CONSTRAINT messages_reply_same_chat;
ALTER TABLE message_changes DROP CONSTRAINT message_changes_chat_id_message_id_fkey;
ALTER TABLE message_changes ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE message_changes
    ADD COLUMN kind varchar(8) NOT NULL DEFAULT 'UPSERT' CHECK (kind IN ('UPSERT','REMOVED','CLEARED')),
    ADD COLUMN sequence bigint,
    ADD COLUMN cleared_through_sequence bigint;
UPDATE message_changes c SET sequence = m.sequence, kind = CASE WHEN m.deleted_at IS NULL THEN 'UPSERT' ELSE 'REMOVED' END
FROM messages m WHERE c.chat_id = m.chat_id AND c.message_id = m.id;
DELETE FROM messages WHERE deleted_at IS NOT NULL;

CREATE TABLE deletion_operations (
    actor_id varchar(26) NOT NULL REFERENCES users(id),
    request_id varchar(26) NOT NULL,
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    fingerprint char(64) NOT NULL,
    scope varchar(8) NOT NULL CHECK (scope IN ('SELF','EVERYONE')),
    target varchar(8) NOT NULL CHECK (target IN ('MESSAGES','HISTORY','CHAT')),
    through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
    mutation_revision bigint NOT NULL CHECK (mutation_revision >= 0),
    visibility_revision bigint NOT NULL CHECK (visibility_revision >= 0),
    deleted_rows bigint NOT NULL DEFAULT 0 CHECK (deleted_rows >= 0),
    purge_rows_before bigint NOT NULL DEFAULT 0 CHECK (purge_rows_before >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, request_id)
);
CREATE INDEX deletion_operations_chat_idx ON deletion_operations(chat_id, actor_id, request_id);

CREATE TABLE history_purge_jobs (
    chat_id varchar(26) PRIMARY KEY REFERENCES chats(id),
    through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_purge_jobs_age_idx ON history_purge_jobs(created_at,chat_id);
CREATE INDEX history_purge_jobs_fair_idx ON history_purge_jobs(updated_at, chat_id);

CREATE TABLE visibility_cleanup_jobs (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    user_id varchar(26) NOT NULL REFERENCES users(id),
    through_sequence bigint NOT NULL CHECK (through_sequence >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id,user_id)
);
CREATE INDEX visibility_cleanup_jobs_fair_idx ON visibility_cleanup_jobs(updated_at,chat_id,user_id);
