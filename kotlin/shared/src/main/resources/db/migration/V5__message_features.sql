ALTER TYPE send_rejection_reason ADD VALUE 'INVALID_REPLY_TARGET';

ALTER TABLE chats
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by varchar(26) REFERENCES users(id),
    ADD COLUMN mutation_revision bigint NOT NULL DEFAULT 0 CHECK (mutation_revision >= 0),
    ADD COLUMN mutation_floor bigint NOT NULL DEFAULT 0 CHECK (mutation_floor >= 0);

ALTER TABLE chats DROP CONSTRAINT chats_kind_shape;
ALTER TABLE chats ADD CONSTRAINT chats_kind_shape CHECK (
    (kind = 'DIRECT' AND name IS NULL AND (direct_pair_key IS NOT NULL OR deleted_at IS NOT NULL)) OR
    (kind = 'GROUP' AND name IS NOT NULL AND direct_pair_key IS NULL)
);

ALTER TABLE messages
    ADD COLUMN message_version bigint NOT NULL DEFAULT 1 CHECK (message_version > 0),
    ADD COLUMN edited_at timestamptz,
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN reply_to_message_id varchar(26),
    ADD CONSTRAINT messages_chat_id_id_unique UNIQUE (chat_id, id),
    ADD CONSTRAINT messages_reply_same_chat FOREIGN KEY (chat_id, reply_to_message_id) REFERENCES messages(chat_id, id);

ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK (
    (deleted_at IS NULL AND length(body) BETWEEN 1 AND 4000) OR
    (deleted_at IS NOT NULL AND body = '')
);

CREATE TABLE message_changes (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    revision bigint NOT NULL CHECK (revision > 0),
    message_id varchar(26) NOT NULL,
    changed_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, revision),
    FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id)
);
CREATE INDEX message_changes_retention_idx ON message_changes(changed_at, chat_id, revision);
