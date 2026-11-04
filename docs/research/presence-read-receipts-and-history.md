# Presence, read receipts and history

Research date: 2026-11-04. This document is research and a proposed contract, not an implementation or measured performance result.

## Scope and evidence

Repository evidence was checked against [AGENTS.md](../../AGENTS.md), [CONTEXT.md](../../CONTEXT.md), [the broker decision](../adr/0001-messenger-broker-split.md), message persistence, client recovery and gateway lease code. External source facts have primary-source links. Proposed policies, algorithms, limits and cost analyses are engineering recommendations or deductions, explicitly labeled as such.

The user clarified that deletion of either kind of chat is global. Either direct participant may delete a direct chat; the creator may delete a group. A deleted direct pair must permit a new conversation without exposing the deleted conversation. Metrics and Grafana iterations are authorized for implementation, but no runtime, instrumentation or dashboard changes were made for this research. The accepted policy is global deletion for both chat kinds.

Repository constraints remain decisive. Applied acknowledges device incorporation, received-message releases a notification, and dismissed advances a chosen recovery baseline without proving incorporation. None means human read. SQL owns durable state; RabbitMQ accepts send commands; Redis room history is bounded and expendable. Keep request deduplication, membership enforcement, explicit transactions and ACK after commit. The completed outbox is deleted and cannot double as a client change log. [Local terms](../../CONTEXT.md), [broker decision](../adr/0001-messenger-broker-split.md), [message persistence](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/message/repository/JooqMessageRepository.kt).

## What published protocols establish

These are source facts, not a requirement to copy another protocol.

- Matrix uses cumulative public and private read-up-to markers, supplies a receipt timestamp, distinguishes receiving from reading, and recommends batching receipts per room and thread. Its presence combines device data at the homeserver and sends updates to interested users sharing room membership. This supports cumulative semantics and authorized aggregation, but does not establish a seven-day per-message first-read archive. [Matrix receipts](https://spec.matrix.org/latest/client-server-api/#receipts), [Matrix presence](https://spec.matrix.org/latest/client-server-api/#presence).
- XMPP XEP-0333 explicitly gives displayed markers an all-messages-up-to-this-point meaning, distinguishes them from delivery receipts, and calls their displayed-state inference heuristic. Multi-device displayed-state synchronization is outside its stated requirements. A cumulative marker is therefore a normal product contract, not proof that each row crossed the viewport. [XEP-0333](https://xmpp.org/extensions/xep-0333.html).
- Telegram publishes `messages.readHistory` with positive `max_id` marking IDs at or below that value. Its group reader API returns participants with dates and documents both group-size limits and expiry measured from message send time. Its direct read-date API also has age and privacy errors. These are API semantics; they reveal neither Telegram's storage schema nor universal numeric limits. Do not hard-code a seven-day value from these pages. [Read history](https://core.telegram.org/method/messages.readHistory), [group read participants](https://core.telegram.org/method/messages.getMessageReadParticipants), [direct read date](https://core.telegram.org/method/messages.getOutboxReadDate).

Recommendation: adopt a cumulative per-user/chat read-through pointer, with recent timestamp history, unless the user explicitly requires exact physical visibility of individual messages. The audits' visible-message-ID proposal is a valid stricter alternative. It should not silently become the default when the user's pointer proposal can meet the intent.

## Presence architecture

### Redis facts and current leases

Redis Pub/Sub is at-most-once. Disconnected subscribers lose messages. Sharded Pub/Sub uses hash slots and confines propagation to a shard. Redis Cluster multi-key operations require compatible slots, and asynchronous replication can lose acknowledged writes. Lua scripts execute atomically but block other server activity during execution. [Pub/Sub](https://redis.io/docs/latest/develop/pubsub/), [Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/), [Lua scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/).

Redis expiration is for keys. Expiry notifications occur when Redis actually deletes the key, can be delayed, and are node-local in Cluster. They are not a reliable deadline scheduler. [Keyspace notifications](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/), [EXPIRE](https://redis.io/docs/latest/commands/expire/).

The current [lease implementation](../../ws/internal/redisroom/connection_leases.go) already uses Redis TIME, a per-user hash tag, random lease IDs, ten fleet-wide sockets, 90-second expiry scores and 30-second renewal. Acquire and renewal prune expired scores; renewal cannot recreate a vanished lease. Release removes the named lease but does not prune other expired members. [Batch renewal](../../ws/internal/redisroom/connection_lease_batch.go) pipelines at most 128 entries at a time. These are directly inspected source facts. Lease acquisition precedes successful socket establishment according to the gateway audit, so a failed handshake can briefly reserve capacity.

### Recommended snapshot-first design

All of this subsection is a design inference from the failure properties above and the existing gateway lifecycle.

Reuse the connection ZSET as the source of approximate connected status. Define online as at least one unexpired established connection lease, across all gateways and devices. Do not test key existence or raw ZCARD. A bounded script obtains Redis TIME and counts scores strictly greater than now; the existing ten-member cap makes this small. ZCOUNT supports score ranges and documents logarithmic complexity. [ZCOUNT](https://redis.io/docs/latest/commands/zcount/), [Redis TIME](https://redis.io/docs/latest/commands/time/).

Decide explicitly whether a reserved pre-upgrade lease counts as connected. I recommend exposing presence only after successful establishment, by adding an established flag or a promotion step associated with the same lease. Keep capacity reservation separate in meaning, even if it shares storage. Failed promotion/cleanup must fall back to expiry. Do not change a renewal into an unconditional upsert.

Use a node-owned presence coordinator with reference-counted unique peer targets. Each socket supplies a bounded watch set; the coordinator checks each unique peer once per refresh interval and distributes changes locally. No goroutine, timer, Redis subscription or SQL authorization request per peer per socket. Keep batches, concurrency, pending authorization, output items and output bytes bounded, with cancellation and joined workers at shutdown.

Suggested starting limits, to tune under load:

- 100 peers per socket, 100 targets per snapshot request, and a separate per-account watch-change rate limit. Ten sockets must not yield ten independent account budgets.
- Refresh watched peers every 15 seconds, jittered without exceeding a configured maximum interval. Add a Redis query deadline, a maximum coordinator scheduling delay and a client snapshot validity deadline, initially 30 seconds after observation.
- A node-wide target cap and queue budget. On overload reject extra watches or return unknown; do not silently keep serving arbitrarily old observations.

Return status with observation time, validity duration and a connection/watch-generation token. Use one ordered refresh per peer locally; discard responses from replaced socket/watch generations. Refresh immediately after reconnect and on watch creation, then periodically. A stale or failed observation becomes unknown, not offline. A client can use a duration measured from receipt with a monotonic timer instead of trusting its wall clock.

With a healthy Redis clock, bounded scheduling and bounded requests, a gateway crash leaves online status for at most the remaining 90-second lease plus the next refresh and delivery delay. A conservative initial target is roughly 105 seconds plus declared scheduler/network budgets, measured from the last successful renewal. It is not an unconditional real-world bound during partitions, long pauses, failover or clock jumps. When refresh exceeds its validity deadline, display unknown. Redis TIME avoids gateway-to-gateway clock disagreement but is still wall-clock time and may differ after failover.

Graceful closure of one device leaves the user online while another valid device remains. A last-device close becomes offline on the next snapshot. Session revocation must close/release the affected sockets through existing authorization machinery. A live TCP connection whose lease renewal fails must not continue indefinitely as an authorized online session.

Start with periodic snapshots alone. They handle silent crash, missed updates and cache expiry with one mechanism. If the measured 15-second graceful-disconnect delay is undesirable, add Pub/Sub transition hints on successful establishment/release. A hint schedules a coalesced snapshot; it does not overwrite status with an unverified boolean. This avoids needing a permanent cross-failover version counter just to order transient presence events. Expiry still requires snapshot reconciliation. If authoritative transition events are introduced later, handle key recreation and failover with an epoch/reset plus resnapshot, since an expiring counter can restart.

A transition script must count valid members before and after, prune expired members on release too, and use the same user slot for keys and sharded channel. No cluster-wide atomic transaction spans arbitrary watched users. Avoid publishing every renewal. Consider whether the deployed Redis version supports the intended scripting/channel combination before implementation; this report does not assert that arbitrary multi-slot scripts work.

### Authorization, reconnect and fleet aggregation

Recommendation: authorize each watch in a specific current shared-chat context. Search visibility is not permission to observe presence. A direct conversation or a visible member page can provide the context. Validate viewer and target membership, reject deleted chats, stop watches on removal/deletion/session revocation, and reauthorize before a short grant expires. Use bounded authorization batches and caches keyed by viewer, target, context and membership revision. Never share an authorization decision merely because several viewers watch the same target. Permission checks apply to snapshots as well as subscriptions. A cached grant has a revocation-delay budget: if an invalidation is lost, access can persist until grant expiry unless the request rechecks SQL. Declare that bound, refresh authorization before expiry and fail closed on refresh failure. Do not describe bounded cached authorization as immediate revocation. The audits identify the existing group/session gRPC seam but no peer-watch authorization API. [connection leases](../../ws/internal/redisroom/connection_leases.go), [message persistence](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/message/repository/JooqMessageRepository.kt).

Inference: Redis state for a target can be shared among local viewers after separate authorization. For node n watching U_n unique users every P seconds, baseline target checks are approximately sum(U_n)/P across the fleet. Pipelining reduces round trips, not command count. This still multiplies work when a popular peer is watched on every gateway. Use per-node aggregation first. If measurements warrant it, partition refresh ownership by target hash and have workers publish bounded snapshots to interested gateway nodes, retaining deadlines and resnapshot on owner change. Such workers add ownership/failover complexity and still need to read current leases. A global subscription on every gateway is not free horizontal scaling.

Reconnect should use exponential backoff with jitter, cap parallel snapshot/authorization requests, coalesce repeated watch sets, and warm only selected-chat/visible peers first. Never scan the entire Redis keyspace or all contacts on every reconnect. A thousand clients watching one peer on one node should yield one refresh, not a thousand. Clear queued peer data when authorization ends.

For group online counts, do not sum node-local socket totals: devices overlap nodes, and users may have several sockets. Count distinct authorized member user IDs against current lease observations. A 100,000-member chat requires a budgeted asynchronous aggregate or a clearly labeled partial/sample count; it must not force each viewer to watch every member. Approximate presence needs neither SQL writes every 30 seconds nor a durable exact last-seen promise.

## Recommended read-through contract

This section defines a proposed application contract, not a borrowed wire standard.

For each user/chat persist W, the greatest accepted read-through chat sequence. Advancing to T means the user declares every eligible message at sequence <= T read. Account devices share W. This is independent of each device's applied/dismissed baseline and of Redis replay cursors. Use canonical decimal strings for SQL sequence fields on the wire, as required by repository rules.

Default emission should occur only from an active, visible selected chat when the user reaches the newer end of a contiguous reading range, or explicitly chooses Mark read. Background catch-up, HTTP fetch, transport ACK, pinned latest updates and old reply navigation never emit read-through automatically. A detached history jump does not imply the user read the skipped interval. An explicit Mark read through here action may intentionally do so. Avoid claiming the server knows human attention.

When W=100 and a device declares T=150 at server acceptance time t1, newly covered messages 101..150 receive t1. A later T=180 at t2 gives 151..180 t2. A delayed T=130 is a no-op, preserving all first times. A device that jumps to 500 must either emit no read update or intentionally declare the skipped prefix read. There is no way for a cumulative pointer simultaneously to mark 500 read and leave 101..499 unread.

Define the timestamp as the first successful server-accepted declaration covering that message, at database precision. It is not the first physical viewing time, and offline clients do not retroactively rewrite it with their own clocks. After a transaction commits but its response is lost, retry returns the current W without changing existing times. Concurrent devices serialize on the user/chat progress row. The first serialized successful advance assigns the time for its newly covered interval. A larger target winning first legitimately makes a smaller later target a no-op.

Durable W remains after timestamp details expire. For messages older than seven days, read/unread can still be inferred from W under this contract, but reader timestamp details are unavailable. That is a retention policy about recent detail, not deletion of all evidence of progress. Exclude the sender from the displayed reader list and count. A range may cross the reader's own messages and several senders; sender boundaries have no meaning for cumulative progress and must not reset it.

Edits preserve sequence, creation time and read state. A first read of the original version is not proof that an edit was seen. If edited-content acknowledgment is required, it needs a version-specific model. Message deletion retains a tombstone and suppresses receipt details for that deleted message by policy; it does not rewind W. New members currently can read prior history according to the backend audit. Keep that policy explicit rather than inventing historical membership intervals.

### Atomic write and timestamped ranges

Recommendation: keep `chat_read_progress(chat_id,user_id,through_seq,revision,last_accepted_at)` with primary key `(chat_id,user_id)`. In an explicit SQL transaction, authorize current membership and nondeleted chat, validate the target belongs to that chat and is not in the future, create the progress row if absent, lock it, and compare T with W. For T>W insert immutable first-read intervals for newly covered recent messages, advance W and enqueue the account progress notification together. For T<=W return current state and emit nothing. Preserve existing membership-removal serialization; a cached precheck alone is insufficient. Avoid serializing all readers on the chat row when a consistent membership/progress locking protocol can suffice.

PostgreSQL row locks block conflicting writers until transaction end. `INSERT ... ON CONFLICT` can resolve unique-key races atomically. These support a per-user/chat critical section; a naive read-then-update outside the transaction does not. Lock ordering and retries still need real database tests. [Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html), [INSERT](https://www.postgresql.org/docs/current/sql-insert.html).

A single bare W plus its latest timestamp loses earlier first-read times. Store intervals `(lo_seq,hi_seq,first_read_at)` with inclusive bounds and no overlap for a given user/chat. Append only above W. Merge adjacent intervals only if their timestamp and retention bucket match exactly. Equal timestamps from one batch are legitimate. Ranges with different timestamps cannot be merged without losing information.

### A retention-safe range representation

The following is a recommended refinement to avoid assuming creation times are ordered by sequence. The existing audits establish immutable creation times, not monotonic wall clocks.

Partition recent range detail by the UTC creation day of the messages it describes. Store `read_ranges(creation_day,chat_id,user_id,lo_seq,hi_seq,first_read_at)`. A row applies only to messages whose immutable creation day equals its `creation_day` and whose sequence is in its bounds. For a new advance `(W,T]`, write the same interval to each creation-day bucket intersecting the seven-day eligibility window. A rolling 168-hour interval intersects at most eight UTC calendar days. Empty bucket intervals are allowed; this avoids scanning or expanding a million-message prefix merely to discover which days contain messages.

Ranges do not overlap for the same `(creation_day,chat_id,user_id)`, because all inserts are above the locked W. Numeric intervals in different day buckets may coincide, but they describe disjoint message sets. A message selects exactly one day bucket and therefore at most one interval for its user. This is an intentional storage definition, not eight separate reads of a message. Never coalesce across bucket boundaries.

Suggested constraints and indexes, as design sketches rather than migrations:

```sql
PRIMARY KEY (creation_day, chat_id, user_id, hi_seq)
CHECK (lo_seq > 0 AND lo_seq <= hi_seq)
CREATE INDEX read_progress_chat_readers
    ON chat_read_progress (chat_id, user_id) INCLUDE (through_seq);
```

The lock-and-append algorithm enforces nonoverlap. If independent writers are later allowed, add a database exclusion constraint for inclusive sequence ranges with compatible equality operator classes, rather than trusting a CHECK to compare other rows. PostgreSQL documents exclusion and multicolumn foreign-key constraints. [Constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).

For a known message and reader, find the first interval with `hi_seq >= message.sequence`, ordered by hi_seq, limit one, for exact day/chat/user equality. Then test its lo_seq outside that limited subquery. It is a match only when lo_seq <= sequence. This makes one candidate lookup instead of scanning all older intervals. The equality-prefix B-tree layout follows PostgreSQL's documented index rules. The particular schema and lookup are deductions. [PostgreSQL 17 multicolumn indexes](https://www.postgresql.org/docs/17/indexes-multicolumn.html).

This representation costs at most eight inserted rows per successful advance and one progress row per user/chat. It trades a bounded factor of empty interval rows for simple, creation-based expiry and constant numbers of inserted rows per request. It does not make disk usage constant: A advances in retained buckets can occupy up to 8A interval rows, plus indexes/WAL/replicas. Updates one message at a time still approach one timestamp interval per message per reader within its own day. Measure the factor before accepting this representation over simpler ranges with an explicitly maintained chronological creation invariant.

### Seven-day eligibility and automatic cleanup

Recommendation: use an exact elapsed duration of 604800 seconds. A message has timestamp details while `created_at <= server_now` and `created_at > server_now - 604800 seconds`. At the exact seventh-day boundary details become unavailable. Include `details_expires_at` in the response and recheck eligibility on every detail request, including cursor continuation. Edits, late reads and retries never extend this deadline. A message first declared read at age 6d23h has one hour of visible timestamp detail remaining.

Choose PostgreSQL `timestamptz(6)` and server UTC serialization. PostgreSQL timestamps support microsecond resolution; transaction timestamps represent transaction start, while statement and clock timestamps have different meanings. Persist last_accepted_at with progress even when timestamp buckets are cleaned. Take the authoritative acceptance time after obtaining the progress lock, and prevent clock rollback from making later intervals appear earlier, for example by clamping against the last accepted timestamp. Preserve microseconds in storage and the API; the UI may format seconds. Tied times are expected, so pagination always needs an ID tiebreaker. [Date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html), [current-time functions](https://www.postgresql.org/docs/current/functions-datetime.html).

Use creation-day partitions, never partitions keyed by read time. Drop or detach a bucket only after its UTC end plus 604800 seconds has passed. The whole bucket is then ineligible regardless of when its ranges were written. Run a bounded scheduler, for example one expired partition per pass with a lock timeout, and precreate only a bounded number of day partitions. Retry failed cleanup and alert on oldest retained expired bucket. PostgreSQL documents efficient partition removal and that partitioned unique constraints must include the partition key. [Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html).

Daily partition cleanup leaves expired detail physically present for up to a day plus scheduling lag. API eligibility is exact throughout. This is an explicit physical-cleanup grace, not read-time-based retention. If physical erasure must occur at each message's exact expiry, daily ranges are insufficient. Use finer creation buckets for a smaller bounded grace, or explicit per-message rows with expiry-indexed batches and a documented deletion SLA. Backups, replicas and logs require their own retention policy if the requirement means physical erasure everywhere.

A nonpartitioned initial implementation can delete expired creation buckets in short batches ordered by `(creation_day,chat_id,user_id,hi_seq)`, using that primary key, `LIMIT`, row locking and `SKIP LOCKED`, committing each batch. PostgreSQL warns SKIP LOCKED gives an inconsistent view, appropriate for queue-like work; it is suitable for cleanup, not reader truth. [SELECT locking](https://www.postgresql.org/docs/current/sql-select.html). Cleanup progress must revisit skipped rows and monitor lag. Rows removed by DELETE still need vacuum; ordinary vacuum makes space reusable without generally shrinking the file. Partition removal and logical expiry are separate mechanisms. [Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html).

Do not attempt a permanently self-updating index with `WHERE created_at > now()-interval '7 days'`. PostgreSQL requires index expressions and predicates to use immutable functions. A time-dependent predicate is not a rolling retention mechanism. Use ordinary indexes and explicit cutoffs or creation partitions. [CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html).

### Alternatives and unavoidable costs

These comparisons are deductions about the defined contracts.

| Model | Guarantee | Cost and limitation |
| --- | --- | --- |
| One W and latest timestamp | Cumulative durable progress | O(user/chat pairs), but cannot reconstruct earlier first-read timestamps |
| W plus immutable timestamp intervals | Cumulative progress and first accepted crossing time | O(successful advances) recent intervals; the proposed creation buckets add at most an eightfold insertion factor |
| Explicit `(message_id,reader_id,first_read_at,expires_at)` | Independently observed messages and skipped-message fidelity | O(actual read pairs), unique-key dedup is simple; a batch of k IDs writes up to k rows |
| Timestamped sparse visible intervals | Independent visible intervals with first times | Overlap subtraction and splitting under user/chat lock; arbitrary scroll jumps can fragment to singleton messages |
| Rounded timestamp buckets | Approximate first time | Better compression only if loss of precision is accepted and documented |
| Latest pointer only with on-demand current reader list | Who is currently beyond a message | Cannot answer when each reader first crossed it |

Explicit rows should have a unique `(message_id,reader_id)`, an expiry index `(expires_at,message_id,reader_id)`, and a reader page index `(message_id,first_read_at,reader_id)`. Derive expires_at from immutable message creation plus 604800 seconds and enforce it on ingestion/query. `ON CONFLICT DO NOTHING` preserves the first accepted time under duplicates. Use a bounded explicit ID batch or SQL-expand only bounded intervals. Never enumerate untrusted unbounded integers. This is the better alternative if skipped messages must remain unread after reaching a later message.

Information cost cannot be eliminated by changing tables. For N messages and U readers, independently selectable read membership alone has up to N×U bits of possibilities; independent timestamps carry more information. Cumulative semantics remove arbitrary membership patterns, but every one-message advance can still introduce a distinct timestamp. Same-sender runs do not solve alternating timestamps or interleaved authors. Neither seven-day retention nor range compression establishes constant storage regardless of message rate, group size, advances or cleanup backlog.

## Reader details, summaries and fanout

Recommendation: fetch reader details lazily only for the opened message. Validate current viewer membership, nondeleted chat and eligible nondeleted target in SQL. Decide whether details are visible to every current member or only the author; start with current members if the product promises a group reader list. Preserve former-reader attribution while the message is eligible unless privacy policy says otherwise. Display a missing/deleted account with a stable safe label. Do not rewrite historical reading into current membership.

The range model favors writes and per-user lookups, not a globally indexed timestamp-order reader list. Use stable user-ID keyset pagination for exact details initially:

1. Bind the cursor to chat, message, session/authorization context and a scan position. Set response limits, initially 50 results and at most 500 progress-row candidates examined per request.
2. Read candidate progress rows by `(chat_id,user_id)` after the scan position. For candidates whose W covers the message, do the bounded day/chat/user range lookup and return the timestamp.
3. Return the last candidate scanned, not merely the last matching reader. A page may be short or empty with a continuation cursor. Keep a bounded scan budget; sparse matches must not scan an entire million-member chat in one request.
4. State that traversal is a live view, not a stable historical SQL snapshot. Readers newly becoming eligible behind the cursor appear after refresh. For a frozen list, materialize a bounded-lifetime snapshot or hold an as-of history contract; a timestamp cursor alone cannot reconstruct overwritten progress state.

An index on `(chat_id,through_seq,user_id)` may help a covering-reader search, but a sequence inequality plus arbitrary user-ID ordering does not magically become a bounded sorted lookup. Benchmark the actual query and sparse-match cases. A GiST containment index on range rows is another possible tradeoff, with update/index cost and result sorting still proportional to matching readers. Do not promise constant-time exact counts.

For summaries, start with `any_read`/a bounded sample and a count explicitly marked approximate or pending for large groups. Compute exact count on demand under a bounded background job or scan all candidates with an explicit cost budget. Cache short-lived summaries for requested messages and batch their invalidations. A progress update can cover a million messages, so synchronously updating a count row for every covered message defeats the point of ranges. If exact real-time counts are mandatory at all group sizes, choose and benchmark a separate aggregation index/materialization design; it is additional work and storage.

Send coalesced W updates to the reader's own user room for device synchronization. For other viewers, invalidate only active detail/summary subscriptions, bounded by connection and node budgets, or refresh summaries periodically. An author observing a few recent messages may receive one coalesced chat/read-summary invalidation. Do not emit one message event for each newly covered message and broadcast it to every member. With U readers and U subscribed members, that policy can approach U² live deliveries per activity cycle. Paginated detail lookup and bounded active observers avoid making all-member broadcast the default.

Durable SQL is the receipt truth. On reconnect refetch own progress and open summaries/details; do not replay a full receipt event archive. Outbox progress events must be transactional and duplicate-safe, but receipts can use snapshot recovery independently of durable message-content changes.

## Edits, deletions and durable recovery

The failure is local and concrete: after applying message sequence 100, a device reconnecting with afterSeq=100 cannot learn that message 5 was edited. Bounded Redis replay and deleted outbox rows cannot fix that after an outage. This follows from the repository's creation-sequence recovery and broker decision. [message history](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/message/service/MessageHistoryService.kt), [broker decision](../adr/0001-messenger-broker-split.md).

Recommendation: give messages monotonically increasing versions and preserve immutable ID, creation sequence and creation time. Delete into a body-free tombstone, and merge every HTTP/live/pending path by version. Reject stale edits with expected-version concurrency. Disable editing tombstones. In the same mutation transaction, write current state, a durable chat change record and outbox publication. Use `(chat_id,change_sequence)` as a separate keyset cursor for creates/edits/deletes. It is neither a message applied sequence nor a Redis Stream cursor.

Capture an authorized change high-watermark before taking a history snapshot, then drain changes after it. A consistent SQL snapshot is preferable; otherwise ensure later change replay and version comparison cover races. Never set the cursor to an arbitrary latest live event while skipping intervening changes. Retain changes for a declared period and return an explicit reset when the cursor predates the retained floor. Reset means discard/refetch all bounded retained windows and reply previews, not just append newer creations. If events carry current state rather than the historical version, accept a newer version and never regress.

A simpler valid first release uses a durable chat revision and complete invalidation/refetch of both bounded windows on reconnect/revision mismatch. It has higher transfer cost and needs careful snapshot/live reconciliation, but can recover old edits without an indefinitely retained log. Live-only mutation events are not a valid alternative. This is an engineering tradeoff, not an external protocol requirement.

Global deletion must be one durable authorization transition. Serialize it with sends/mutations, reject later operations in every repository and gateway authorization path, invalidate watches/subscriptions, and purge local composer/history/reader/reply state. Either direct participant and the group creator are the proposed authorized actors. An older queued send must observe deletion and record a terminal rejection after checking SQL, even if its Rabbit command was accepted before deletion.

Retain chat deletion/removal information in account synchronization or reconcile a complete authorized chat list. One paginated list page is not proof that all absent cached chats were deleted. Chunk any large membership cleanup/fanout job and keep SQL denial immediate; no transaction should publish 100,000 personal notifications synchronously as the only recovery path.

A deleted direct chat must release its active pair uniqueness or use an explicit conversation generation. The fresh chat gets a new ID; never restore the old messages or reuse old progress/replay state. Preserve request-result identity so retrying an old accepted send cannot silently become a send to the new chat. Soft deletion plus generation-aware pair lookup is safer than immediate cascading deletion. These are recommendations grounded in the audit's unique direct-pair key and retained send results. [chat persistence](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/repository/JooqChatRepository.kt).

## Replies and million-message history

Recommendation: enforce same-chat reply identity using unique `(chat_id,id)` on messages and composite foreign key `(chat_id,reply_to_message_id)` referencing it. A plain target-ID FK proves existence only. Include reply target in send fingerprints, durable retry state and both single/batch send paths. Reject new replies to deleted/inaccessible targets by policy; already committed replies retain identity and show a deleted preview when their target is later deleted. PostgreSQL supports multicolumn foreign keys. [Constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).

Fetch short current previews with a bounded join/batch. Do not store recursive quote bodies or preserve deleted text in an immutable quote snapshot unless the product explicitly wants that retention. Version target previews too: refreshing a reply row must not restore stale target text after deletion. Keep tombstones addressable for navigation, without exposing body history.

The existing message ID primary key locates a reply anchor, while unique `(chat_id,sequence)` supports neighbors. Authorize the anchor within the requested chat, then select at most 24 predecessors descending, the anchor and 25 successors ascending in one statement or consistent snapshot. Reverse predecessors in the bounded result and return ascending order plus before/after availability. Fetch one extra neighbor if needed for availability flags. Total output remains capped by the HTTP history maximum. Include tombstone anchors; inaccessible or missing targets leave the current viewport intact.

PostgreSQL B-trees can deliver sorted output, including reverse scans; equality on leading columns and a sequence range suit the existing index. Large OFFSET still computes skipped rows, so it is inappropriate for a jump to message one million. The bounded indexed around-target query is a design inference, and must be checked with EXPLAIN on the real schema. [Index ordering](https://www.postgresql.org/docs/current/indexes-ordering.html), [multicolumn indexes](https://www.postgresql.org/docs/17/indexes-multicolumn.html), [LIMIT/OFFSET](https://www.postgresql.org/docs/current/queries-limit.html).

Do not promise flat latency independent of history length. B-tree traversal, cache residency, heap access, visibility and membership checks still matter. The intended cost is index seeks plus a bounded neighbor result, rather than loading intermediate pages or sorting all history. Preserve 64-bit sequences as strings/BigInt in the client.

## Bounded browser state and pinned latest

Recommendation based on the client audit: keep a 50-message latest page independently from one detached sliding history range capped at 200. Only the active range renders. The selected chat retains at most 250 saved-message references, plus separately bounded pending sends. Drop the detached range on chat switch, rather than caching every visited target. Bound inactive-chat previews, directory retention, names, receipt pages, in-flight requests and any entity map too. Shared entities must be released when no retained range/pending state refers to them. A count cap only bounds bytes when message/preview lengths and auxiliary state are also bounded.

Far-history reveal fetches one around-target window, installs it without changing transport or human-read baselines, scrolls/highlights the anchor and leaves Back to latest reachable outside the scrolling content. New live messages update the pinned latest page without moving the detached viewport or marking anything read. A gap in pinned latest requires authoritative latest replacement, never concatenation across missing sequences. Returning can render pinned content immediately and refresh; explicit dismissal of any recovery gap retains its existing meaning.

Capture stable message-ID/pixel-offset anchors around paging, eviction, variable-height edits and quote resizing. Use chat/navigation generation tokens and caller cancellation to discard late page/reveal results. Repeated navigation to the same target still needs a new generation. Reader dialogs retain only a bounded page, and chat removal clears all dependent state.

TanStack Query v5 supports bidirectional infinite paging and `maxPages`, limiting retained pages and sequential refetch work. That does not reserve a pinned latest page or implement transport continuity. If adopted, use a separate latest resource and bounded detached query, and control query-key count/cache lifetime, not just pages within one key. [Infinite queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries).

TanStack Virtual provides stable item keys, overscan, dynamic measurement and indexed scrolling. It reduces mounted rows, not retained fetched data, and cannot retrieve an unknown remote target. [Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer). Recommendation: retain the tested history/recovery owner; add virtualization if layout measurements warrant it. Introducing a second message cache does not remove version merge, cancellation, pinning or ACK rules.

## Metrics and performance evidence

Source facts: Prometheus warns against unbounded labels such as user IDs, recommends base units, and distinguishes aggregatable histogram observations from precomputed summary quantiles. Grafana describes RED for service rate/errors/duration and USE for resource utilization/saturation/errors. [Metric naming/cardinality](https://prometheus.io/docs/practices/naming/), [histograms](https://prometheus.io/docs/practices/histograms/), [Grafana dashboard practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/).

Recommendations: add missing instrumentation during implementation and iterate against baseline. No user/chat/message/session/target IDs, raw URL paths, cursor values or arbitrary errors as metric labels. Use finite enums for operation, outcome, direction and reason, and ordinary deployment instance labels. Put individual IDs only in access-controlled sampled diagnostic logs where needed, not time-series labels. Cap histogram bucket counts and account for the multiplication by label combinations. Aggregate histogram buckets across nodes before computing fleet quantiles; do not average node p99 values.

| Area | Bounded-cardinality measurements and Grafana panels |
| --- | --- |
| Presence | Active socket/watch/unique-target gauges, refresh seconds and batch size, Redis operations, unknown/rejected snapshots by finite reason, scheduler lag, renewal failures, expiry-to-observed-offline delay in controlled probes, reconnect request rate, queue items/bytes/drops; node/fleet sharing ratio |
| Reads | Requests by advance/no-op/denied/error, lock/query seconds, accepted sequence-distance histogram, range rows inserted per advance, candidate rows scanned per result, reader-page latency/continuations, summary refresh work and outbox age |
| Retention | Oldest expired creation bucket age, cleanup duration/rows/partitions per pass, lock failures, eligible/expired storage bytes from bounded scheduled collection, vacuum/dead tuples; alert on growing lag rather than exact expiry event delivery |
| Mutations/deletion/replies | Commit/conflict/denial counts by fixed operation, transaction/outbox/recovery latency, revision-regression drops, reset/refetch counts, deletion fanout backlog, quote target outcomes and preview bytes |
| History/client | Query seconds by latest/older/newer/around, rows examined via benchmark plans and returned-size histogram, target request count, browser retained objects/heap/DOM nodes/anchor displacement, queue/CPU/RSS/DB saturation |

Benchmarks must record fixture shape, hardware, versions/configuration, concurrency, cache warm/cold state, warm-up exclusion, measurement duration and percentile distributions. Compare original send-heavy baseline with low-rate many-user direct chats, small groups and a hot large group. Measure Redis commands and bytes, SQL rows/index/WAL bytes, outbox deliveries and browser allocations per logical action, not throughput alone. Set numerical regression gates only after baseline measurements. No benchmark was run for this report.

## Failure and benchmark matrix

The expected outcomes and experiments below are recommendations for implementation verification, not established test results.

| Scenario | Required outcome | Evidence to collect |
| --- | --- | --- |
| Two devices on different gateways; close one, crash last | User remains online after first close; crash becomes offline within healthy-system lease/refresh budget or unknown on stale observation | Redis lease scores, refresh lag, end-to-end probe delay, no duplicate per-socket polling |
| Redis outage/failover/clock step, lost Pub/Sub, expired key recreated | Unknown after validity deadline; successful snapshots recover; no old boolean/version pins stale state | State transitions, failover timeline, errors, query rate, bounded queues |
| 1k/10k simultaneous reconnects; popular peer on every node | Jitter/coalescing, bounded auth/refresh concurrency and memory, no keyspace scan | Targets versus watches, per-node/fleet Redis work, CPU/RSS, rate rejection and latency tails |
| Revoked session/member, deleted watch context, slow authorization response | Stop watch and discard queued/stale completion data; deny new snapshots | Permission race tests and late-generation tests |
| Multi-device W advances 100→150 and 100→180, duplicates/reordering, lost response | Monotonic W, no overlap per day, immutable first accepted times, transactional outbox | Real PostgreSQL races, rollback injection, returned timestamps/ranges |
| Old-history jump, hidden tab, transport catch-up, explicit Mark read | First three do not emit a read mutation; explicit cumulative action covers skipped prefix | Client interaction tests plus public HTTP/WS verification |
| One-message advances, same-sender runs, alternating senders, large prefix jump | Precise timestamps; measured worst-case intervals; at most eight bucket inserts per advance | Rows/index/WAL bytes, transaction latency and lock contention |
| Read at 6d23h, exact expiry, cleanup stopped, UTC day boundary, clock adjustment | One hour remaining; exact API cutoff despite physical lag; retry/edit never extends expiry | Controlled clock tests, expiry fields, partition eligibility and cleanup recovery |
| Sparse readers in 100k-member group; repeated detail pages | Candidate scan bound, continuation after scanned candidate, no group-wide reader broadcast | Query plans/rows, page latency/empty continuation behavior, fanout bytes |
| Message 5 edited/deleted after device applied 100, Redis replay lost | Durable changes or revision reset repairs both windows/previews, no resurrection | Offline system test, cursor floor reset, duplicate/reordered version tests |
| Global direct/group deletion versus queued send, fresh direct conversation | Authorized global denial/purge, creator-only group policy, old retries cannot enter new chat | Real transaction races, account reconciliation, all-device tests |
| Foreign-chat/missing/deleted reply target and old target mutation | Reject new invalid replies, retain prior tombstone references, no body leak | FK/API tests, single/batch send fingerprint and retry tests |
| 10k/100k/1M history, first/middle/last target, warm and cold cache | One around request with bounded neighbors; no intermediate page walk/OFFSET | EXPLAIN ANALYZE BUFFERS on isolated fixtures, API p50/p95/p99 and bytes |
| Thousands of pages, rapid jumps/chat changes, live arrivals and tall edited rows | Latest pinned, ≤250 selected saved references, bounded other caches, stable anchors, stale results ignored | Repeatable browser heap/DOM/request evidence, geometry and keyboard/mobile checks |
| Mixed feature load alongside original sends | Quantified tail/throughput/resource regression and identified saturation | Grafana baseline/comparison windows, broker/DB/Redis metrics and client memory |

## Decision and remaining semantic questions

Recommended policy: approximate connected presence from the existing leases with authorized, node-aggregated periodic snapshots and explicit unknown/staleness. Add Pub/Sub only as a latency hint after measuring. Keep a durable monotonic per-user/chat read-through pointer and immutable server-accepted timestamp ranges for recent message creation buckets. Use strict 168-hour API eligibility and bounded creation-bucket cleanup with a stated physical-erasure grace. Fetch reader details in budgeted keyset pages, coalesce own-device progress and active-view invalidation, and avoid broadcasting every reader/message pair to all members. Keep immutable message coordinates, versioned tombstones, durable mutation recovery and new IDs for recreated direct conversations. Retain one bounded detached history range plus an independently pinned latest page.

Honest alternatives: explicit receipt rows are simpler for exact skipped-message visibility and timestamp-ordered reader pages, at a potentially much larger write/storage cost. A lone pointer is enough only if historical first-read times are dropped. Revision-based full bounded-window refresh can replace a durable mutation log initially if all invalidation and cursor-reset rules are implemented. Daily timestamp-range buckets intentionally favor bounded writes and cleanup over exact per-message physical erasure or cheap exact global reader counts.

Questions that truly change the contract:

1. Does read mean declared cumulative progress, including intentionally skipped earlier messages, or independently viewed messages? The recommendation chooses cumulative progress; a reply jump alone does not declare it.
2. Is the required timestamp first server acceptance, or a client-reported offline viewing time? The recommendation chooses server acceptance at microsecond storage precision.
3. Does seven days restrict visible timestamp detail, or require physical erasure everywhere at exact expiry? The recommendation gives exact API expiry and up to one day plus monitored cleanup lag for physical range removal, with independent backup retention.
4. Must groups of any size show exact real-time reader counts and timestamp-sorted lists, or are budgeted user-ID pages and cached/pending counts acceptable? Exact counts/order may justify explicit rows or separate aggregation storage.
5. May all current members inspect recent readers, including former members, or only authors? Are private receipts required? The recommendation exposes details to current members, excludes self from counts, and does not add private receipt semantics implicitly.
6. Should reading an edited version require a separate acknowledgment? The recommendation retains creation-level read state through edits.

Global deletion scope is settled by the user and is not an open question. The proposed authorization is either direct participant or group creator, with a fresh conversation ID after direct-chat recreation.

## Implemented storage refinement

The implementation uses the creation-day model with a bounded exact lookup for short advances. At most 256 crossed sequences are inspected through the existing chat/sequence index, and only eligible creation days actually present receive intervals. Larger advances use the constant eight-day fallback without inspecting the crossed prefix. This keeps arbitrary creation-time ordering valid and reduces ordinary same-day writes to one interval per advance. A short prefix containing only expired messages writes no timestamp intervals. Temporary two-second notification dedup keys expire after two minutes; durable frontiers and seven-day timestamp eligibility are independent. These are implementation choices, with interface tests and workload measurements recorded separately from the external research claims.
