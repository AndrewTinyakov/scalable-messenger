ALTER TABLE chats ADD COLUMN last_activity_at timestamptz;
UPDATE chats SET last_activity_at = latest.created_at
FROM (SELECT chat_id, max(created_at) AS created_at FROM messages GROUP BY chat_id) latest
WHERE chats.id = latest.chat_id;
