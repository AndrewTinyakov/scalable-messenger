# Chat, member and account sequences, and replica-ready reads

Status: accepted.

Clients used to repair missed hints by polling four selected-chat routes every 12–15 seconds. In the 1,000-user load profile those polls were 57% of all HTTP requests. Instead, three counters number every change, so a client can tell exactly when it missed something and fetch only what moved.

## Counters

- **Chat sequence.** `chats.next_sequence` numbers every shared event: saved messages, edits, deletions for everyone, shared clears, shared pins and membership changes. Every writer allocates it under the chat row lock that sends already take. A send batch takes a consecutive range.
- **Member sequence.** `chat_members.member_seq` numbers one account's private changes in one chat. Its events go only to that account's user room, so other members never learn they happened and their chat sequence has no hole for them.
- **Account sequence.** `users.event_seq` numbers changes that belong to no single chat.

The only new chat column is `pins_seq`, the chat sequence of the last shared pin change. Unpinning deletes rows, so without it every check would have to refetch up to 200 pins. The mutation sequence needs no column: it is the newest `message_changes.seq`, or the mutation floor once retention has pruned the log.

## Client behaviour

Every frame carries the counter its change took. A frame one above the last value the client holds is applied directly. A larger gap, a reconnect, `recovery_failed`, focus, or a minute without a check triggers one `GET /v1/chats/{id}/state`. That response returns:
- the chat, pin, mutation and member sequences;
- the visibility cutoffs;
- both read positions.

The client then fetches only the parts whose sequence moved. The one-minute check covers the one case gap detection cannot see: losing the last frame before a quiet period.

The `message_saved` ack, closing the socket on ack timeout, and Redis replay are unchanged. A frame that goes unacknowledged on a healthy TCP connection means the device is frozen or unreachable, so a resend on that socket would fail the same way. Reconnecting instead resumes from the device's own position on any gateway, without per-device buffers on the server.

Other members' read receipts take no chat sequence. Giving them one would put a chat row lock every two seconds per busy chat on the row sends use. The two-second shared hint stays, and `/state` returns read positions inline.

A chat sequence reveals how many shared events a viewer cannot see, for example after messages are deleted for everyone. It never reveals their content.

## Replica reads

`ReadTransactions` offers read-only `primary { }` and `replica { }` transactions. When `messenger.database.replica.url` is set, an `AbstractRoutingDataSource` below jOOQ sends `replica { }` to the replica pool. `replica { }` returns null at once in three cases:
- no replica is configured;
- a once-per-second `pg_stat_replication` check shows the replica too far behind;
- the replica fails.

The service owns freshness. A client sends the highest chat sequence it holds as `minSeq`. `/state` accepts a replica result only when the replica's chat head is at least that high, and otherwise reads the primary once. Every replica read is counted by outcome: served, rejected, unavailable or failed.

These reads stay on the primary, because they must reflect current state:
- gateway authorization;
- sessions;
- send status and request deduplication;
- the outbox publisher;
- reads inside writes.

A member removed by someone else can still read a lagging replica for as long as it lags. That is the same as reading just before the removal, and live delivery stops at once because gateway authorization uses the primary.

Runtime pools connect through PgBouncer in transaction mode. Flyway and the publisher's `LISTEN` connection connect directly, because they need a session. Snapshot reads set `REPEATABLE READ` inside the transaction: the JDBC isolation setter changes the whole session, and that change would leak to other clients sharing the same pooled backend.

## Considered options

- **A separate event counter beside the message sequence, plus an event log with retention and difference endpoints** (the Telegram `pts` shape). It keeps message numbers dense, but nothing depends on dense numbers. It would add a growing table, a cleanup worker, two paging endpoints, a membership fence and lock-ordering rules. The only change kind that can accumulate without limit, edits and deletions, already has `message_changes`.
- **One private counter per account.** A gap would only say that something in the account changed, which forces a recheck of every chat.
- **Acks for every event type.** Hints are superseded by newer ones, and some are coalesced or deliberately dropped before sending. Gap detection repairs them without per-event state in the gateway.
- **WAL LSN consistency tokens.** These need an LSN sample after every commit, token versions per primary, and timeline handling on failover. They give read-your-writes but not monotonic reads. Chat sequences are ordinary row data that survive failover and rise with reads too.
- **Sending a client to the primary for a fixed time after it writes** (the Rails default). It costs primary capacity during the window and returns stale data whenever lag outlasts the window.
- **Sending every read that needs fresh data to the primary.** Nearly every chat read follows an event or an open, so replicas would take almost nothing.
