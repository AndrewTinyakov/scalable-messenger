# Broker choices for the WebSocket projects

These notes use first-party broker documentation. A project's client command path, background work path, live WS-node fanout path, and reconnect path can use different mechanisms. The choices below are proposed project designs, not vendor architecture claims.

## Keep four jobs separate

1. **Accept a command.** Decide if a user's action is valid, save the accepted result, and tell the client what was accepted.
2. **Run background work.** Give a task to one worker, retry a failed worker, and record failure.
3. **Reach online WS nodes.** Send an accepted event only to WS nodes with clients who need it.
4. **Recover a client.** After a gap, give the client its missing accepted events or the latest state.

A broker can acknowledge a message to a worker without proving that a browser received it. Product history needs an application cursor, a durable source of truth, and a recovery path. Redis Pub/Sub explicitly provides at-most-once delivery and no replay. RabbitMQ acknowledges a delivery to its consumer application. Kafka and Redis Streams retain events for later consumers, subject to retention and topology. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/), [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability), [Kafka introduction](https://kafka.apache.org/intro/), [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/).

## What each technology is good at

| Technology | Strong fit | Poor fit for these projects |
| --- | --- | --- |
| Redis Pub/Sub, optionally sharded | Low-latency online fanout to WS nodes subscribed to a room. No stored backlog. | Accepted commands or client history that must survive a subscriber outage. [Redis docs](https://redis.io/docs/latest/develop/pubsub/). |
| RabbitMQ queues and exchanges | Work items that one worker processes with acknowledgement, retry, routing, and dead-letter handling. A topic exchange can route events to node queues with bindings. | Long-term client history. A queue acknowledgement means the WS node or worker took responsibility, not that each connected client received the message. [RabbitMQ reliability](https://www.rabbitmq.com/docs/reliability), [exchanges](https://www.rabbitmq.com/docs/exchanges). |
| Redis Streams | Bounded retained event log and worker consumer groups with acknowledgement; useful when Redis is already operated and the retained window is moderate. | Using one consumer group for all WS nodes that must receive the same event: a group shares work, so only one consumer in that group gets each entry. Independent readers or groups are required for fanout; that can become expensive with many WS nodes and rooms. [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/). |
| Kafka | High aggregate event throughput, independent downstream consumers, partitioned retention and replay, and order within a partition. | Direct room-to-interested-WS-node fanout. A consumer group splits partitions among its members, so one group across WS nodes does not give each interested node an event. A single very hot room keyed to one partition can also bottleneck that partition. [Kafka introduction](https://kafka.apache.org/intro/), [Kafka design](https://kafka.apache.org/43/design/design/). |

The terms “fast” and “slow” are workload-specific; benchmark end-to-end latency, broker CPU, broker egress, consumer lag, and recovery behavior. Kafka or RabbitMQ persistence does not automatically make a WebSocket delivery durable.

## Proposed use in each project

| Project | Accept/process | Live WS delivery | Reconnect |
| --- | --- | --- | --- |
| Messenger | WS node publishes a send request to partitioned RabbitMQ quorum queues and says `queued` after publisher confirm. A worker validates membership and saves the message, request result, per-conversation sequence, and outbox in one SQL transaction; then it ACKs the queue delivery. | Redis sharded Pub/Sub reaches WS nodes interested in user or group rooms; bounded per-room Redis Streams retain recent events. | Redis replays a complete short gap when possible. Otherwise the API fetches every saved message after the client's SQL conversation sequence. `messageId` remains a ULID. See the [Messenger architecture](messenger-architecture.md) and [broker decision](../docs/adr/0001-messenger-broker-split.md). |
| Kanban | API commits the card edit and outbox row together; each desk has a version. | Redis Pub/Sub to the WS node holding desk viewers. During reassignment, old and new nodes may both need the event. | API provides a versioned snapshot plus newer changes. Stale live events are ignored by version. |
| Twitch-like chats, many rooms with hot outliers | API validates, rate-limits, moderates, and persists accepted chat events. Kafka is justified if aggregate rate and independent consumers such as moderation audit and analytics need a retained log. Keying by room gives per-room partition order but constrains a hot room to one partition. Redis Streams is a simpler **alternative** for a shorter retained window and moderate rate. | A fanout service consumes accepted events, then sends to interested WS nodes via Redis sharded Pub/Sub or direct node-addressed delivery. Kafka/Streams work-sharing consumers should not be attached directly as one shared group across the WS nodes. Very hot rooms may need a relay fanout tier. | API reads a bounded room history or durable database by room sequence. Kafka/Streams offsets are internal processing cursors, not automatically usable client history. |
| Optional remote-command agents | API stores a command and dispatches through a RabbitMQ queue. A worker finds the connected agent and sends the command to its WS node. Worker and agent acknowledgements are separate; persist command state and retry or expire it. | Direct node-targeted delivery is more appropriate than a room broadcast. | A reconnecting agent asks for still-pending commands from the API. |
| Optional market watchlist | Synthetic feed or API updates current symbol values. | Redis Pub/Sub reaches interested WS nodes; WS nodes may coalesce obsolete price snapshots for slow clients. | Read the newest value per symbol from a cache or API, not every prior price tick. Actual trades remain separate durable events. |

## Database-to-broker reliability

If the API saves a message and then publishes a broker event as two unrelated operations, a crash between them can leave a saved message with no live notification. The transactional outbox records both the business row and event row in one database transaction. A relay later publishes the event, possibly more than once, so consumers need idempotency. Debezium can tail the outbox changes rather than waiting for a coarse scheduled poll. For Messenger, RabbitMQ's publisher confirm permits `queued`; only the later database commit permits `saved`. [Debezium outbox router](https://debezium.io/documentation/reference/transformations/outbox-event-router.html), [RabbitMQ confirms](https://www.rabbitmq.com/docs/confirms).

## A useful comparison experiment

For the Twitch-like case, compare `DB/outbox -> Redis Streams -> fanout` with `DB/outbox -> Kafka -> fanout` under the same accepted-message workload. Messenger has a different command contract: the confirmed RabbitMQ queue owns a request before SQL has a copy, while Redis handles events after SQL commit. The second broker has a specific job; adding it alone does not prove WebSocket delivery.
