# Messenger: exact send, fanout, and recovery flow

This describes the implemented local path and explores possible later deployments. The local stack uses PostgreSQL, RabbitMQ 4.3, one Redis instance, and a polling outbox relay. It assumes server-stored chat history, direct chats and bounded group chats, multiple devices per user, and asynchronous send commands. SQL is the authority for saved messages. Redis carries live events and keeps a short replay cache. RabbitMQ quorum queues accept send commands before SQL has a copy. The [decision record](../docs/adr/0001-messenger-broker-split.md) explains the broker split. Timeouts and capacity limits still require load and failure tests.

## Terms and promises

- A **room** is a logical destination. `user:alice` reaches Alice's connected devices. `group:42` reaches connected devices of members of group 42. A WS node maintains `room -> local sockets` and has one Redis subscription per locally active room, not one Redis subscription per socket. In this design, connected group members join their group rooms even if that chat is not open. For very large numbers of memberships, use per-user inbox notifications plus DB fetch instead.
- `requestId` identifies a send attempt across client retries. `messageId` is the stable message identity (ULID). `(chatId, sequence)` is the authoritative ordered history cursor. `(room, epoch, streamId)` is only the short Redis recovery cursor. These are different identifiers.
- `queued` means a RabbitMQ quorum queue confirmed the command. `saved` means the SQL transaction committed. `applied` means one device acknowledged incorporating the event. Avoid the unqualified word `delivered`; neither `queued` nor `saved` proves device application.
- The application guarantees eventual recovery of **committed** messages while the SQL history is retained, provided clients reconnect or run a catch-up check. It does not promise zero duplicates or bounded live delivery during every network fault. Client and relay retries are expected.

## Components

```mermaid
flowchart LR
  A[Alice devices] --> P[WS proxy]
  B[Bob devices] --> P
  P --> W1[WS node A]
  P --> W2[WS node B]
  W1 -->|confirmed send command| Q[(RabbitMQ quorum queue partitions)]
  W2 -->|confirmed send command| Q
  Q --> C[Command worker / API binary]
  C --> D[(PostgreSQL or MySQL / Vitess)]
  W1 -->|authorize room subscriptions| C
  W2 -->|authorize room subscriptions| C
  D --> R[Outbox relay binary]
  R -->|append short history + publish| X[(Redis)]
  X -->|active room subscription| W1
  X -->|active room subscription| W2
  A -->|HTTP catch-up| C
  B -->|HTTP catch-up| C
```

The relay is a separate long-running process. It can be deployed as another process in the API image, but its lifecycle and retry state are independent of WebSocket connections.

## Why one RabbitMQ queue per room is not broadcast

With a queue `group:42` and two consumers (WS nodes A and B), RabbitMQ distributes each queued delivery to **one** consumer. A may receive message 1 and B message 2, leaving each node's local clients missing the other message. To broadcast through RabbitMQ, publish to an exchange with a room routing key and bind **a separate queue per WS node** to every room that node serves. Each matching queue receives its own copy. This is a viable competing design: queue count follows node count; binding count follows active room-node pairs. It is much less expensive than Avito's old queue-per-connection shape, but binding churn, bind/publish races, queue lifetime, and node move/recovery still need work. RabbitMQ exchange routing and the competing-consumers pattern are documented in [Exchanges](https://www.rabbitmq.com/docs/exchanges) and [Work Queues](https://www.rabbitmq.com/tutorials/tutorial-two-python).

## Joining a room (authorization and race closure)

```mermaid
sequenceDiagram
  autonumber
  participant App as Alice app
  participant Proxy as WS proxy
  participant WS as WS node A
  participant API as API / command service
  participant DB as SQL database
  participant Redis as Redis
  App->>Proxy: HTTP Upgrade /ws + auth token
  Proxy->>WS: forward upgrade and socket bytes
  WS->>API: validate token/session
  API-->>WS: Alice identity, session validity
  WS-->>App: WebSocket established
  App->>WS: subscribe group:42 + lastApplied cursor
  WS->>API: authorize Alice for group 42
  API->>DB: SELECT membership WHERE user=Alice AND chat=42
  DB-->>API: active member + membership version
  API-->>WS: allow + version
  WS->>WS: register local socket; mark room catching-up
  opt First local listener for room
    WS->>Redis: SSUBSCRIBE room:{42}:live
    Redis-->>WS: subscription acknowledged
  end
  WS->>WS: buffer incoming live events for this socket
  WS->>Redis: read epoch, retained cursor and tail of stream:{42}
  alt Cursor retained in same epoch
    WS->>Redis: XRANGE entries after lastApplied stream ID
    Redis-->>WS: replay entries
    WS-->>App: replay entries in stream order
  else Cursor absent or epoch changed
    WS-->>App: recovery_failed; request DB catch-up
    App->>API: GET /chats/42/messages?afterSeq=N
    API->>DB: SELECT ... WHERE chat_id=42 AND seq>N ORDER BY seq LIMIT ...
    DB-->>API: committed rows
    API-->>App: messages + next cursor
  end
  WS-->>App: buffered live events after replay (dedupe by messageId)
  App->>App: apply in chat sequence; persist cursor
  App-->>WS: applied ACK with last DB sequence and Redis cursor
```

Subscribe **before** reading history and buffer live traffic while replaying. Otherwise an event can fall between the history read and the live subscription. The API must also reject or end a subscription when membership is revoked; a long-lived authorization decision is not sufficient. A fresh client without a valid Redis cursor starts from SQL. Redis stream IDs are monotonic but not gapless; check that the previous stream entry itself is retained, not whether IDs differ by one.

## Sending the first direct message

Selecting Bob opens a local draft in Alice's client. No chat row exists yet. Alice sends a command addressed to `recipientId=Bob`; the WS node hashes the sorted Alice/Bob pair into one of four RabbitMQ quorum queues and returns `queued` after publisher confirmation. A later send to the committed chat uses `chatId` as its target.

```mermaid
sequenceDiagram
  autonumber
  participant A as Alice app
  participant W as WS node
  participant Q as RabbitMQ
  participant C as Command worker
  participant D as PostgreSQL
  participant R as Outbox relay
  participant X as Redis
  participant B as Bob app
  A->>W: send(recipientId=Bob, requestId=r9, body)
  W->>Q: publish persistent command to hash(sorted pair) queue
  Q-->>W: publisher confirm
  W-->>A: queued(r9)
  Q->>C: deliver r9
  C->>D: BEGIN; lock sender/request ID
  C->>D: validate Bob and lock direct pair
  C->>D: insert chat and members if absent
  C->>D: lock chat; allocate sequence; insert message and saved result
  C->>D: enqueue chat_created for Alice and Bob
  C->>D: enqueue message_saved for Alice and Bob
  C->>D: COMMIT
  C->>Q: ACK command
  R->>D: claim committed outbox rows
  R->>X: XADD bounded room Stream and SPUBLISH in one script
  X-->>A: chat_created and message_saved
  X-->>B: chat_created and message_saved
  A->>A: refresh chat list and apply message
  B->>B: refresh chat list and apply message
```

The chat, membership, first message, sequence, saved result, and outbox rows commit together. The sorted pair has a unique SQL key and an advisory transaction lock, so opposite first sends resolve to one chat. An invalid recipient records a rejection against the sender and request ID without creating a chat. Repeating the command with the same request ID reads the stored result and does not save a second message.

Group creation commits the group and its members immediately, with one `chat_created` outbox event to each member's user room. Group messages later use the group room. Every connected device joins its user's room, so chat list changes reach users before they open the new chat. The client also fetches the chat list and SQL history on reconnect because Redis live publication is temporary.

The publisher claims indexed outbox batches with `FOR UPDATE SKIP LOCKED` and deletes successfully published rows after Redis publication. A crash between Redis publication and the delete can publish the same event again; clients deduplicate messages by ID. The Redis script appends to a bounded Stream and publishes to sharded Pub/Sub in the same hash slot. SQL history remains the complete catch-up path. Send status is available at `GET /v1/sends/{requestId}` for the authenticated sender, including a direct request that has no chat ID yet.

## PostgreSQL wakeup

An `AFTER INSERT FOR EACH STATEMENT` trigger sends a payload-free `messenger_outbox` notification after commit. The publisher holds a dedicated `LISTEN` connection and drains claimable batches when signaled. It also scans each second, so a missed notification or expired lease does not leave work stranded. The notification is only a wakeup; the SQL rows hold the durable events. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html).

## Redis history, periodic checks and recovery

For each room, the relay's Redis function appends a short event to `stream:{room}` with `XADD` and publishes the event plus its returned stream ID via `SPUBLISH` to `live:{room}`. Keep stream and room metadata keys in the same Redis Cluster slot. Maintain an epoch that changes when a room history is recreated, and trim by age/size. The stream is a bounded cache, not the full message history. A separate Redis deployment for Pub/Sub and Streams is optional capacity isolation, not a correctness requirement; putting them on separate Redis instances loses the simple same-server function and needs explicit ordering/recovery design. Redis says Pub/Sub itself is at-most-once. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/), [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/), [Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/).

```mermaid
sequenceDiagram
  autonumber
  participant X as Redis
  participant W as WS node B
  participant B as Bob app
  participant API as API
  participant DB as SQL history
  X-->>W: live event at room stream ID s10
  W-->>B: message seq=104, stream=s10
  B->>B: apply and persist lastApplied=(epoch,s10), DB seq=104
  B-->>W: ACK applied s10 / seq104
  Note over X,W: Broker connection silently misses the next and final event s11
  loop Periodic room-node position check, e.g. measured interval
    W->>X: read room epoch and latest stream ID
    X-->>W: same epoch, latest=s11
    W->>W: latest differs from last received s10; mark room stale
  end
  W->>X: verify s10 still retained; XRANGE after s10
  alt s10 retained and epoch matches
    X-->>W: s11 event
    W-->>B: replay message seq=105, stream=s11
    B-->>W: ACK applied s11 / seq105
  else Cursor absent, stream trimmed, or epoch changed
    W-->>B: recovery_failed / sync from SQL
    B->>API: GET messages after DB seq104
    API->>DB: SELECT ... WHERE chat_id=? AND seq>104 ORDER BY seq
    DB-->>API: seq105 and any later rows
    API-->>B: durable history page(s)
    B->>B: apply, dedupe, persist new DB cursor
  end
```

A later event can reveal an order problem sooner, but a missed **last** event has no later event to expose it. This is why Avito's Redis/Centrifugo design used periodic position synchronization, and Centrifugo documents periodic positioning checks. One check per active **room-node** is cheaper than one per socket, but millions of active personal rooms still mean millions of checks per interval. At 1,000,000 active room-node pairs and a 30-second interval, the naive rate is about 33,333 Redis checks/second before batching or jitter. Choose the interval from the maximum acceptable stale time and measured broker load; 30 seconds is an experiment, not a guarantee. Check on reconnect, app focus, and when a user opens a chat as well. If a quiet, healthy-looking socket must learn of a missed final message within a strict deadline and checks cost too much, use a durable node feed or another delivery ledger. [Avito engineering write-up](https://habr.com/ru/companies/avito/articles/522744/), [Centrifugo recovery](https://centrifugal.dev/docs/server/history_and_recovery).

Even a room-node check only says the node saw the room's latest broker position. Clients still ACK their own *applied* position. On slow-client queue overflow, the WS node stops claiming a healthy live view, closes/resyncs that socket, and the client fetches by SQL sequence. If the Redis epoch changes or Redis loses an acknowledged recent write during failover, SQL remains the recovery authority. A Redis-tail check cannot discover a SQL-saved message if the relay marked its outbox row complete and the Redis publication then disappeared. Reconnect and chat-open SQL catch-up remain mandatory. A strict freshness deadline for a continuously open socket needs a database-backed reconciliation rule or durable delivery ledger. Redis replication is asynchronous. [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/).

## Failure branches and observable client states

| Point of failure | What happens | Recovery |
| --- | --- | --- |
| WS node cannot publish the command or receive Rabbit publisher confirm | Client has no reliable `queued` result. | Retry with same `requestId`; query request status after reconnect. A timed-out confirm may have succeeded, so dedupe is essential. |
| Rabbit delivers twice or worker crashes before `basic.ack` | Same command is handled again. | Unique request key returns the previous saved/rejected result; no second message. |
| Membership invalid, message too large, or user rate-limited | WS rejects before queue when possible; worker rechecks authorization and records durable rejection for queued commands. | Publish rejection to sender room, or let sender query `requestId` status if live notification is missed. |
| SQL commit fails | No saved message and no committed outbox row. | Worker may retry transient failures; permanent failure produces a durable rejection result. Never send `saved` before commit. |
| SQL commits but worker crashes before Rabbit ACK | Rabbit redelivers. | Idempotency lookup sees committed result; ACK duplicate. Outbox relay still runs. |
| SQL commits but relay/Redis is down | Message is saved but not yet live. | Pending outbox row stays in SQL and is retried. Clients can also fetch SQL history. |
| Relay publishes then crashes before marking outbox done | Redis may receive the event again. | Client deduplicates `messageId` / event ID. Mark outbox complete only after publish returns. |
| Redis publication reaches Alice's node but not Bob's | Alice sees it; Bob's socket may appear healthy. | Node detects broker disconnection, or position check finds newer Redis tail; if history gone, Bob fetches SQL. |
| Redis history trimmed or failover loses it | Broker cursor cannot prove complete replay. | Return `recovery_failed`; client uses SQL `(chatId, sequence)` cursor. |
| WS node sends to Bob but Bob does not apply | Node's bounded pending ACK times out or socket breaks. | Retry if safely bounded, otherwise force resync; Bob fetches SQL. |
| Bob is offline | No live WS delivery exists. | On reconnect/open, fetch SQL history from last persisted chat sequence. Push notification is a separate best-effort wakeup path. |
| Group membership revoked | Existing socket could otherwise keep receiving group room traffic. | Versioned authorization/revocation event removes socket from room; DB history endpoint enforces membership. The revocation path needs its own recovery check; do not rely solely on a lossy Pub/Sub revocation. |

## MySQL, then Vitess

The core transaction works with InnoDB too: `START TRANSACTION`; insert/lock the idempotency key; check membership with a locking read; update one chat counter row; insert message and outbox rows; `COMMIT`. MySQL 8.4 supports `SELECT ... FOR UPDATE SKIP LOCKED` for queue-like outbox tables. The SQL syntax and lock behavior differ slightly, but the *same-database outbox* principle does not depend on PostgreSQL. [MySQL locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html), [MySQL SELECT](https://dev.mysql.com/doc/refman/8.4/en/select.html).

MySQL has no PostgreSQL `LISTEN/NOTIFY` equivalent. Use a short-interval indexed outbox poller, or consume committed outbox inserts from MySQL's row-based binlog. In Vitess, `VStream` exposes row change streams through `vtgate`, including across shards, and supports resumable CDC workflows. Keep the outbox table as the durable fallback if CDC checkpoints or retention fail. A VStream relay checkpoints only after downstream publication; a crash between publication and checkpoint can duplicate events. [MySQL replication/binlog](https://dev.mysql.com/doc/refman/8.4/en/replication.html), [Vitess VStream](https://vitess.io/docs/25.0/reference/vreplication/vstream/).

For Vitess, shard `chats`, `memberships`, `chat_counters`, `messages`, `send_requests`, and `outbox` by `chat_id`, with matching Vindex placement. One send transaction then stays on one shard. A user-centric chat list, unread count, or search index can be a separate projection updated asynchronously from committed events. Updating a user-sharded inbox in the same transaction as a chat-sharded message would cross shards. Vitess supports cross-shard 2PC, but documents its latency and isolation costs; prefer single-shard writes for this path. A single very hot chat still contends on its counter row; Vitess adds shards for many chats, not unlimited writes to one chat. [Vitess sharding guidelines](https://vitess.io/docs/25.0/user-guides/vschema-guide/sharding-guidelines/), [distributed transactions](https://vitess.io/docs/24.0/reference/features/distributed-transaction/), [shared Vindexes](https://vitess.io/docs/23.0/user-guides/vschema-guide/shared-vindexes/).

```mermaid
sequenceDiagram
  autonumber
  participant C as Command worker
  participant G as vtgate
  participant T as vttablet for chat shard
  participant M as MySQL primary for shard
  participant V as VStream relay
  participant X as Redis
  C->>G: START TRANSACTION; all statements carry chat_id
  G->>T: route transaction to one shard
  T->>M: START TRANSACTION
  C->>G: idempotency + membership + counter + message + outbox SQL
  G->>T: route all SQL to same shard
  T->>M: execute row locks and inserts
  C->>G: COMMIT
  G->>T: commit single-shard transaction
  T->>M: COMMIT; write row changes to binlog
  M-->>T: commit result
  T-->>G: success
  G-->>C: saved
  V->>G: VStream subscribe from checkpoint to outbox changes
  G-->>V: committed outbox insert event
  V->>X: append short history and publish live
  X-->>V: publish operation returned
  V->>V: persist CDC checkpoint after publication
```

Vitess can combine changes from shards in a VStream, but it cannot provide exact global ordering across shards. That is fine here because ordering is per chat and each chat is on one shard. [Vitess VStream skew detection](https://vitess.io/docs/25.0/reference/vreplication/internal/vstream-skew-detection/).

## Could Redis Streams replace RabbitMQ too?

Yes. Partition send commands among several Redis Streams, with a consumer group of API workers for each partition:

```text
WS node --XADD--> command Stream --XREADGROUP--> API worker
                                             --SQL COMMIT--> message + outbox
                                             --XACK-------> command Stream

Outbox relay --XADD--> short room Stream --XREAD, separate cursor per WS node--> devices
```

Workers reclaim abandoned pending commands with `XAUTOCLAIM` and use the stable `requestId` to make retries safe. A command Stream needs a retention rule that does not remove unprocessed commands: default `XTRIM` may remove an entry while its pending reference survives. Redis 8.2 added `XTRIM ... ACKED` to trim only entries acknowledged by all groups. Keep command Streams separate from bounded room-history Streams because their retention and reader semantics differ. [Redis consumer groups](https://redis.io/docs/latest/commands/xreadgroup/), [XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/), [XTRIM](https://redis.io/docs/latest/commands/xtrim/).

The durability distinction is **when SQL has no copy yet**. The WS node could receive a successful `XADD` response and tell Alice `queued`, then Redis could fail over to a replica that lacks that command. There would be no SQL message or outbox row to recover. Redis's default replication is asynchronous. `WAIT` and `WAITAOF` reduce the loss window but do not make Redis a strongly consistent quorum system under all failovers. A confirmed RabbitMQ quorum-queue publication has a stronger documented conditional promise: it survives while a majority of queue replicas remain available. That promise costs replication and disk work on the command path. [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/), [WAITAOF](https://redis.io/docs/latest/commands/waitaof/), [RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues).

Redis-only is therefore a valid choice if `queued` is a weaker, retryable receipt and the client retains and retries a send until it sees `saved` or `rejected`. If `queued` must survive the sender going offline before SQL commit, keep a quorum command queue or persist the command in SQL before acknowledging it. This is the reason to combine RabbitMQ for commands with Redis for live room traffic; it is not a claim that Redis Streams scale poorly in general.

Using Streams for **live room fanout** is also possible. WS nodes independently `XREAD` each active room Stream from their own cursors, so each interested node receives each entry. They must not share one `XREADGROUP` consumer group, because that splits entries among nodes. A healthy reader resumes from its cursor without a separate Pub/Sub history check. Use a bounded blocking timeout and reconnect/cursor comparison to discover a stalled reader; an indefinitely blocked connection is not proof that the node received the latest event. This design maintains many room streams and active readers. Redis documents that an `XADD` waking blocked readers incurs work proportional to the number waiting on that stream. A single global command Stream also belongs to one Redis Cluster slot, so use multiple streams if one slot becomes hot. RabbitMQ queues have their own per-queue leader and likewise require partitioning at large throughput. [Redis XREAD](https://redis.io/docs/latest/commands/xread/), [Redis XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/), [Redis Cluster](https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/), [RabbitMQ queues](https://www.rabbitmq.com/docs/queues).

## Selected broker split and scaling tests

The selected design uses RabbitMQ quorum queues for send commands and Redis sharded Pub/Sub plus short room Streams after SQL commit. `queued` is meant to survive Alice going offline before SQL saves the message, under the quorum queue's documented majority-survival assumption. Redis-only commands remain a valid alternative with a weaker `queued` promise and client retries. Redis Streams do not inherently scale worse; the difference is the safety of the only pre-SQL command copy. [RabbitMQ quorum queues](https://www.rabbitmq.com/docs/quorum-queues), [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/).

Use a fixed pool of command queues selected by `hash(chatId)` for existing chats or `hash(sorted user pair)` for first direct sends, not one global queue and not one queue per room or socket. RabbitMQ says a single queue replica has one CPU core on its hot path. Workers use bounded prefetch. Add workers until SQL commit throughput or one hot chat's sequence row becomes the limit. Set a maximum queue length or byte budget and `reject-publish`, then measure publisher-confirm latency and queue age during bursts. RabbitMQ applies publisher flow control when the queue cannot keep up, and its quorum-queue guide discourages very long backlogs. [RabbitMQ queues](https://www.rabbitmq.com/docs/queues), [prefetch](https://www.rabbitmq.com/docs/consumer-prefetch), [flow control](https://www.rabbitmq.com/docs/flow-control), [queue limits](https://www.rabbitmq.com/docs/maxlength), [quorum queue limits](https://www.rabbitmq.com/docs/quorum-queues).

Measure Redis room-node subscriptions, publish-to-device-ACK latency, Stream memory, recent replay rate, and SQL fallback rate separately from the command queue. Test Rabbit failover immediately after `queued`, a worker crash before ACK, a reconnect storm, the quiet missed-final-event case, and a hot group with many WS-node readers. The result should set partition count, backlog budget, Stream retention, and position-check interval.
