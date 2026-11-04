CREATE TABLE pending_read_notifications (
    chat_id varchar(26) NOT NULL REFERENCES chats(id),
    user_id varchar(26) NOT NULL REFERENCES users(id),
    PRIMARY KEY (chat_id, user_id)
);
