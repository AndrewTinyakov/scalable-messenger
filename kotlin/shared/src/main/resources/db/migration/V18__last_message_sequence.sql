ALTER TABLE chats ADD COLUMN last_message_sequence bigint NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0);
UPDATE chats SET last_message_sequence = next_sequence - 1;

UPDATE deletion_operations SET seq = 0, member_seq = 0;
