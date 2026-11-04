ALTER TABLE messenger_outbox_events
    ADD COLUMN publication_order bigint GENERATED ALWAYS AS IDENTITY;

CREATE UNIQUE INDEX messenger_outbox_events_publication_order_idx
    ON messenger_outbox_events(publication_order);

CREATE INDEX messenger_outbox_events_pending_room_order_idx
    ON messenger_outbox_events(room, publication_order)
    WHERE published_at IS NULL;
