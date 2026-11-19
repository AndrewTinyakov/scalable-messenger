# One sequence per chat, per member and per account, and replica-ready reads

Status: accepted, not yet implemented.

Messages already follow a clean model: `chats.next_sequence` numbers them, the gateway tracks acks for them, and clients replay them from a position. Every other change uses its own hint type, its own revision, or no revision at all. Clients repair missed hints by polling four selected-chat routes every 12–15 seconds. In the 1,000-user load profile those polls were 57% of all HTTP requests. We replace this with three counters that every change advances, so a client can detect any missed change and refetch only what it needs.

## Counters

**Chat sequence.** `chats.next_sequence` numbers every shared event in a chat, not only messages:
- each saved message;
- an edit;
- a delete-for-everyone operation (one number per operation);
- a shared clear;
- a shared pin or unpin;
- a membership change;
- a group close.

Every writer allocates through the same `UPDATE chats … RETURNING`, so the chat row lock that sends already take serialises all shared changes. A send batch still takes a consecutive range.

**Member sequence.** `chat_members.member_seq` replaces `visibility_revision`. It numbers one account's private changes within one chat:
- personal deletion and personal clear;
- self chat deletion;
- personal pins;
- mute;
- the unread mark;
- the account's own read-through.

It locks only that member row. Its events go only to the account's user room, so other members never see that they happened.

**Account sequence.** `users.event_seq` numbers changes that belong to no single chat:
- being added to or removed from a chat;
- chat pin order;
- the account's own profile and sessions.

## Schema

The schema adds one column to `chats`: `pins_seq`, the chat sequence of the last shared pin change. Unpinning deletes rows, so a row scan can't tell whether pins changed. Without the column, every gap would refetch up to 200 pins. No other per-kind column is needed:
- `message_changes` rows store the chat sequence of the change, so "changes after N" is a plain range query. `mutation_revision` goes away, and `mutation_floor` stays for retention.
- Member pages are fetched only while the member panel is open.
- `/state` returns read positions inline.

## Client behaviour

Every chat frame carries `seq`, private frames carry `memberSeq`, and account frames carry `userSeq`. Every write response returns the number its change took.

A client applies a frame when its number is exactly one above the number it last applied. A larger number is a gap. On a gap, a reconnect, `recovery_failed` or focus, the client calls `GET /v1/chats/{id}/state`. That one response returns:
- the chat head and `pins_seq`;
- the member sequence and its visibility cutoffs;
- the account's own read-through;
- the highest read-through among other active members.

The client then refetches only what moved: history after its position, changes after its position, pins, or its own visibility. An account gap reloads the chat list. A 60-second check per selected chat replaces the 12–15 second polls. It covers the one case gap detection cannot see: losing the last frame before a quiet period.

**Unchanged.**
- The `message_saved` ack, and closing the socket when an ack times out, stay as they are. A frame that goes unacknowledged on a healthy TCP connection means the device is frozen, throttled or unreachable, and a resend on that socket would fail the same way. Reconnecting resumes from the device's own position on any gateway, without per-device buffers.
- Redis replay keeps its room, epoch and Stream ID cursor.
- A large group still costs one publication per event, whatever its size.

Holes in the chat sequence already exist after deletion and personal hiding. Clients cross them only through server-certified history coverage (ADR 0002). A non-message event at sequence N advances the client's certified position the same way.

**Read receipts.** Read receipts from other members take no chat sequence. They return inline from `/state` and keep the two-second shared hint from ADR 0002. Giving them chat numbers would add a chat row lock every two seconds per busy chat, on the same row sends use. A missed read hint is repaired at the next event or check.

**Profiles.** When usernames or avatars become editable, `users.profile_version` will order them. Messages and chats store only user IDs. Every response that includes a user carries that user's version, and clients refetch a user when they see a higher version than they have cached. A rename never fans out to chats or messages. Only the account's own devices learn of it through the account sequence.

**Privacy.** A chat sequence reveals how many shared events a viewer cannot see, for example after messages were deleted for everyone. It never reveals their content. Private changes use member or account sequences, so they leave no hole in another member's chat sequence.

## Reads and replicas

Code written now must need only configuration to use a read replica later.

**Routing.**
- An `AbstractRoutingDataSource` sits below the existing jOOQ `DSLContext` and `TransactionTemplate`. The SQL-tagging listener keeps working unchanged.
- Writes and ordinary `tx.execute` calls always use the primary.
- A small `ReadTransactions` component offers read-only `primary { }` and `replica { }`. It chooses the route before the transaction opens. It knows nothing about chats.
- With no replica configured, or while a once-per-second `pg_stat_replication` check shows the replica too far behind, `replica { }` returns no result immediately.

**Freshness.** Freshness is a domain rule owned by the service. The client sends the highest number it has seen: `minSeq` for chat reads, `minUserSeq` for the chat list. The service reads from the replica and accepts the result only when its head is at or above that number. Otherwise it runs the read once on the primary:
- `/state` returns its head as part of the result, so the check costs nothing extra.
- The chat list checks `users.event_seq` before loading the page, in the same snapshot, so a stale replica costs only one indexed lookup.
- A not-found result from the replica also falls back to the primary, so a member who was just added never gets a false 404.

Event delivery normally takes tens to hundreds of milliseconds, while a healthy replica replays in a few milliseconds. Fallbacks should therefore be rare. They are counted by reason: stale, lagging or replica error.

**Primary only.** These must reflect current state and stay on the primary:
- gateway authorization over gRPC;
- sessions;
- send status and request deduplication;
- the outbox publisher;
- reads inside writes.

`/state`, history and the chat list accept one weaker guarantee. A member removed by someone else can still read from the replica for as long as it lags, which is equivalent to reading just before the removal. Live delivery stops at once because gateway authorization uses the primary.

**PgBouncer.** PgBouncer in transaction mode sits in front of every runtime pool. Three things change:
- Snapshot reads begin with `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY` instead of the JDBC isolation setter, which changes the session.
- Flyway and the publisher's `LISTEN` connection use a small direct pool to the primary.
- Prepared statements need PgBouncer's `max_prepared_statements`.

## Considered options

- **A separate event counter beside the message sequence, plus a `sync_events` log with retention and difference endpoints.** This is the Telegram `pts` shape. It keeps message numbers dense, but nothing depends on dense numbers. It would add:
  - a table that grows with every event;
  - a cleanup worker;
  - two paging endpoints;
  - a membership fence column;
  - lock-ordering rules.

  The only change kind that can accumulate without limit, edits and deletions, already has `message_changes`.
- **One counter per account for all private changes.** A gap would only say that something in the account changed, which forces a recheck of every chat. Per-member sequences keep repair to one chat.
- **Acks for every event type.** Non-message events are hints whose newest value supersedes older ones. Some of them are coalesced or deliberately dropped before sending. Gap detection repairs them without per-event state in the gateway.
- **WAL LSN consistency tokens.** These would mean:
  - sampling `pg_current_wal_insert_lsn()` after every commit;
  - versioning tokens per primary generation;
  - handling timelines on failover.

  Even then they guarantee only read-your-writes, not that reads never go backwards. Domain sequences are ordinary row data: they survive failover, and they rise with reads too. PostgreSQL 19's `WAIT FOR LSN` could later absorb small lag on the replica.
- **Sending a client to the primary for a fixed time after it writes.** This is the Rails default. It uses primary capacity during the window, and it returns stale data whenever lag lasts longer than the window.
- **Sending all fresh-data reads straight to the primary.** Nearly every chat read in this app follows an event or an open, so replicas would take only search and older pages.
