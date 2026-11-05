ALTER TYPE send_rejection_reason ADD VALUE 'INVALID_FORWARD_SOURCE';

ALTER TABLE chat_members
    ADD COLUMN pinned_rank smallint CHECK (pinned_rank BETWEEN 1 AND 10),
    ADD COLUMN muted_until timestamptz,
    ADD COLUMN marked_unread_at timestamptz;

CREATE INDEX chat_members_pinned_idx ON chat_members(user_id, pinned_rank) WHERE pinned_rank IS NOT NULL;

ALTER TABLE messages ADD COLUMN forwarded_from_user_id varchar(26) REFERENCES users(id);

CREATE TABLE message_pins (
    chat_id varchar(26) NOT NULL,
    sequence bigint NOT NULL,
    viewer_id varchar(26) REFERENCES users(id),
    CONSTRAINT message_pins_scope_unique UNIQUE NULLS NOT DISTINCT (chat_id, sequence, viewer_id),
    CONSTRAINT message_pins_message_fkey FOREIGN KEY (chat_id, sequence)
        REFERENCES messages(chat_id, sequence) ON DELETE CASCADE
);
