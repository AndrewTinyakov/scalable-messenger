CREATE TYPE room_kind AS ENUM ('USER', 'GROUP');

ALTER TABLE messenger_outbox_events
    ADD COLUMN room_kind room_kind GENERATED ALWAYS AS (
        CASE
            WHEN starts_with(room, 'group:') THEN 'GROUP'::room_kind
            WHEN starts_with(room, 'user:') THEN 'USER'::room_kind
        END
    ) STORED NOT NULL;
