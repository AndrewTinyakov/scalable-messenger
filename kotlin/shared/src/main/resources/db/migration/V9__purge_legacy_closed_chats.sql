UPDATE chats
SET cleared_through_sequence = GREATEST(cleared_through_sequence, next_sequence - 1)
WHERE deleted_at IS NOT NULL AND cleared_through_sequence < next_sequence - 1;

INSERT INTO history_purge_jobs(chat_id, through_sequence)
SELECT id, cleared_through_sequence
FROM chats
WHERE deleted_at IS NOT NULL AND purged_through_sequence < cleared_through_sequence
ON CONFLICT (chat_id) DO UPDATE
SET through_sequence = GREATEST(history_purge_jobs.through_sequence, EXCLUDED.through_sequence);
