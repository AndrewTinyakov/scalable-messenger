-- NOTIFY makes every committing transaction take one database-wide lock and hold it through its WAL flush,
-- so writers that enqueue outbox events committed one at a time. The application now wakes publishers after commit.
DROP TRIGGER messenger_outbox_events_inserted ON messenger_outbox_events;
DROP FUNCTION notify_messenger_outbox_events();
