# RabbitMQ commands and Redis rooms

Status: accepted.

RabbitMQ quorum queues carry send requests. Return `queued` after publisher confirmation, and acknowledge consumed commands after the SQL transaction commits. The transaction stores the message, scoped request result, chat sequence, and outbox events together.

Redis sharded Pub/Sub carries live room events. The transactional outbox stores bodyless message references. The publisher hydrates current globally visible message rows once per bounded batch, sharing the result across recipient rooms. It withholds quote text from shared frames because personal visibility differs between viewers.

V16 removed the trigger that notified publishers inside each outbox writer's transaction. PostgreSQL holds a database-wide notification lock through the WAL flush, so the trigger serialized those commits. The application now coalesces wakeups and sends them in a separate transaction after the write commits. Wakeups carry no data and can use asynchronous commit. Publishers find the committed rows on their next poll if a wakeup is lost.

A single script appends a bodyless recovery hint to bounded Stream history and publishes the full ephemeral live event in the same cluster slot. Publication retries retain the event ID. Outbox publication can repeat after a crash, so consumers deduplicate. Hint replay coalesces work per chat and requires bounded viewer-authorized SQL recovery. SQL remains authoritative for complete catch-up, including certified deletion gaps. Control events such as membership revocation retain their order during coalescing.

Message content no longer persists in outbox or Stream history. A publisher can hydrate before deletion and publish that snapshot afterward; this is an in-flight response, subject to client revision and visibility reconciliation. This decision does not promise retroactive erasure of network packets, browser memory, unacknowledged Rabbit commands, WAL or backups. Existing plaintext replay must be retired during the deployment procedure before claiming application-store purge completion.

RabbitMQ was chosen because Redis replication can lose an acknowledged command during failover. Redis history is expendable after SQL commit. This adds a broker and processing hop; it does not prove any device applied a message. Queue partitioning spreads chats, while a hot chat or room still has one ordering or fanout bottleneck.

## Publisher wakeups and completion

The writer schedules a PostgreSQL `NOTIFY` after commit. This keeps the notification's commit lock outside the transaction that enqueues durable events. Each process coalesces signals into one running notification and at most one pending notification. Notifications carry no data and use a separate transaction with `synchronous_commit=off`. Publishers poll for committed outbox rows if a notification is lost.

When a room finishes, the publisher commits its completion with any others already waiting. Rooms still publishing can finish independently. If a shared completion commit fails, the publisher retries each room individually so a lost lease only retains that room's outbox rows.

The publisher looks up sender names once per batch to build live sidebar activity. It publishes activity previews over Redis Pub/Sub and keeps them out of the replay stream.
