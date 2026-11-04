WITH picked AS (
    SELECT id FROM messenger_outbox_events
    WHERE payload ? 'body' OR payload ? 'replyBody'
    ORDER BY created_at,id
    LIMIT 1000
    FOR UPDATE SKIP LOCKED
), converted AS (
    UPDATE messenger_outbox_events e
    SET payload = CASE WHEN payload->>'type' = 'message_saved' THEN
        jsonb_build_object('type','message_saved','version',1,
            'eventId',payload->>'eventId','room',payload->>'room',
            'chatId',payload->>'chatId','requestId',payload->>'requestId',
            'messageId',payload->>'messageId','sequence',payload->>'sequence')
        ELSE jsonb_build_object('type','history_changed','version',1,
            'eventId',payload->>'eventId','room',payload->>'room',
            'chatId',payload->>'chatId','sequence',COALESCE(payload->>'sequence','0'),
            'mutationRevision',COALESCE(payload->>'mutationRevision','0'),
            'visibilityRevision','0') END,
        lease_owner = NULL, lease_until = NULL
    FROM picked WHERE e.id = picked.id
    RETURNING 1
) SELECT count(*) FROM converted;
