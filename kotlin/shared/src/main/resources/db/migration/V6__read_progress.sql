CREATE TABLE chat_read_progress (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    user_id varchar(26) NOT NULL REFERENCES users(id),
    through_sequence bigint NOT NULL DEFAULT 0 CHECK (through_sequence >= 0),
    read_at timestamptz,
    active_membership boolean NOT NULL DEFAULT true,
    PRIMARY KEY (chat_id, user_id),
    CHECK ((through_sequence = 0 AND read_at IS NULL) OR (through_sequence > 0 AND read_at IS NOT NULL))
);
CREATE INDEX chat_read_progress_highest_idx ON chat_read_progress(chat_id, through_sequence DESC, user_id) WHERE active_membership;

CREATE TABLE chat_read_ranges (
    chat_id varchar(26) NOT NULL,
    user_id varchar(26) NOT NULL,
    creation_day date NOT NULL,
    after_sequence bigint NOT NULL CHECK (after_sequence >= 0),
    through_sequence bigint NOT NULL CHECK (through_sequence > after_sequence),
    read_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, user_id, creation_day, through_sequence),
    FOREIGN KEY (chat_id, user_id) REFERENCES chat_read_progress(chat_id, user_id),
    CHECK (expires_at = ((creation_day + 8)::timestamp AT TIME ZONE 'UTC'))
);
CREATE INDEX chat_read_ranges_expiry_idx ON chat_read_ranges(expires_at, chat_id, user_id, creation_day, through_sequence);

CREATE TABLE chat_read_notifications (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    bucket bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (chat_id, bucket)
);
CREATE INDEX chat_read_notifications_expiry_idx ON chat_read_notifications(expires_at, chat_id, bucket);

CREATE FUNCTION update_read_progress_membership() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE chat_read_progress SET active_membership = false
        WHERE chat_id = OLD.chat_id AND user_id = OLD.user_id;
        RETURN OLD;
    END IF;
    UPDATE chat_read_progress SET active_membership = true
    WHERE chat_id = NEW.chat_id AND user_id = NEW.user_id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER chat_members_read_progress
AFTER INSERT OR DELETE ON chat_members
FOR EACH ROW EXECUTE FUNCTION update_read_progress_membership();
