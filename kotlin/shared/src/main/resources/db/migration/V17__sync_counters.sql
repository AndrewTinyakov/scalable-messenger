UPDATE chats SET mutation_floor = next_sequence - 1
WHERE mutation_floor > 0 OR EXISTS (SELECT 1 FROM message_changes c WHERE c.chat_id = chats.id);
DELETE FROM message_changes;

ALTER TABLE message_changes DROP CONSTRAINT message_changes_pkey;
ALTER TABLE message_changes RENAME COLUMN revision TO seq;
CREATE INDEX message_changes_chat_seq_idx ON message_changes(chat_id, seq, sequence);

ALTER TABLE chats
    DROP COLUMN mutation_revision,
    ADD COLUMN pins_seq bigint NOT NULL DEFAULT 0 CHECK (pins_seq >= 0);

ALTER TABLE chat_members RENAME COLUMN visibility_revision TO member_seq;

ALTER TABLE users ADD COLUMN event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0);

ALTER TABLE deletion_operations RENAME COLUMN mutation_revision TO seq;
ALTER TABLE deletion_operations RENAME COLUMN visibility_revision TO member_seq;
