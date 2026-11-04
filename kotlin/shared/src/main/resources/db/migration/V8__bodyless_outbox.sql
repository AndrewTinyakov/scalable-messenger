ALTER TABLE messenger_outbox_events
    ADD CONSTRAINT messenger_outbox_bodyless
    CHECK (NOT (payload ? 'body') AND NOT (payload ? 'replyBody')) NOT VALID;
