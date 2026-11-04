# RabbitMQ commands and Redis rooms

Status: accepted.

RabbitMQ quorum queues carry send requests. Return `queued` after publisher confirmation, and acknowledge consumed commands after the SQL transaction commits. The transaction stores the message, scoped request result, chat sequence, and outbox events together.

Redis sharded Pub/Sub carries live room events. A single script appends bounded Stream history and publishes each event in the same cluster slot. Publication retries retain the event ID. Outbox publication can repeat after a crash, so consumers deduplicate. SQL remains authoritative for complete catch-up when replay cannot prove continuity.

RabbitMQ was chosen because Redis replication can lose an acknowledged command during failover. Redis history is expendable after SQL commit. This adds a broker and processing hop; it does not prove any device applied a message. Queue partitioning spreads chats, while a hot chat or room still has one ordering or fanout bottleneck.
