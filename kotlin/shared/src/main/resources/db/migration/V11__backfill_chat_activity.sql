CREATE OR REPLACE PROCEDURE backfill_chat_activity()
LANGUAGE plpgsql AS $$
DECLARE
    after_id text := '';
    last_id text;
    batch_last_id text;
    started_at timestamptz;
    longest_batch interval := interval '0';
    batches integer := 0;
BEGIN
    SELECT max(id) INTO last_id FROM messages;
    LOOP
        started_at := clock_timestamp();
        WITH batch AS MATERIALIZED (
            SELECT id, chat_id, created_at FROM messages
            WHERE id > after_id AND id <= last_id
            ORDER BY id LIMIT 5000
        ), updated AS (
            UPDATE chats SET last_activity_at = greatest(chats.last_activity_at, latest.created_at)
            FROM (SELECT chat_id, max(created_at) AS created_at FROM batch GROUP BY chat_id) latest
            WHERE chats.id = latest.chat_id
        )
        SELECT max(id) INTO batch_last_id FROM batch;
        COMMIT;
        EXIT WHEN batch_last_id IS NULL;
        batches := batches + 1;
        longest_batch := greatest(longest_batch, clock_timestamp() - started_at);
        after_id := batch_last_id;
    END LOOP;
    RAISE NOTICE 'Chat activity backfill: % batches, longest batch including commit %', batches, longest_batch;
END;
$$;
CALL backfill_chat_activity();
DROP PROCEDURE backfill_chat_activity();
