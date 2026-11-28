---
status: accepted
---

# Gateway-owned presence with bucketed transition channels

This replaces the polling presence design. Under that design, every gateway polled Redis every five seconds for each watched user, twice when a user was both the selected chat peer and a sidebar peer. Every watcher got a frame every five seconds, whether or not anything changed. Each socket renewed a Redis lease every 30 seconds, and every watch was reauthorized over gRPC and SQL every 12–25 seconds. At one million sockets, that is roughly 33,000 lease scripts, 200,000–400,000 frames and 100,000 authorizations per second while nobody's status changes.

The new design uses the sockets a gateway already tracks. Ordinary presence writes happen when a user's local active count crosses zero. Redis publishes only account-level transitions, and the gateway delivers them only to authorized watchers.

## Online, activity and timing

A connection starts active and the client reports activity changes thereafter. It becomes idle after five seconds hidden or unfocused, or after 30 seconds without input, and becomes active again on focus or input. These thresholds come from the server in the handshake, so they can change without a client release. A user is online while at least one of their connections is active, on any device.

When a gateway's last active connection for a user goes away, the gateway waits a two-second grace period before writing. A reload or quick reconnect within that window publishes nothing. Gateways ping sockets every 20 seconds and close a socket after 40 seconds without a pong. A lost network therefore shows offline within about 45 seconds. A clean close shows offline in about two seconds, and a crashed gateway within about 15 seconds. A gateway stopping normally closes its sockets, stops its presence writers and clears its own presence before it exits. It leaves its registration for peers to reap, so anything it could not clear in time still goes offline through the crash path.

## Publisher state

Each user belongs to one of 4,096 buckets. The gateway and the Kotlin outbox publisher use unsigned 32-bit FNV-1a over the UTF-8 user ID, modulo 4,096. The [shared test vectors](../../ws/internal/roomname/testdata/presence-buckets.json) pin this layout. The bucket selects the Redis hash tag `{presence:<b>}` and is part of the key layout. A user's state is the hash `messenger:{presence:<b>}:u:<userId>`. It holds one field per gateway with an active connection, plus the version `v` and the last-seen time `ls`.

A gateway writes absolute counts, never increments, so retries and rewrites are idempotent. A Lua script computes the account state. On a transition it does three things:

- sets `v = max(v + 1, Redis TIME in microseconds)`;
- increments the bucket sequence;
- publishes `{userId, v, seq, state, lastSeen}` with `SPUBLISH presence:{b}`.

The hash, the sequence counter and the channel share a hash tag, so the write and the publish are atomic. Versions keep rising after a failover that loses writes, which matters because watchers drop versions lower than the last one they saw.

Gateways register in a `messenger:gateways` sorted set and heartbeat every five seconds. Each gateway keeps a connection index and a separate presence index. When a gateway's deadline passes, the other gateways race for an expiring `SET NX` claim. The winner confirms the deadline and marks the identity dead before paging through both indexes to clear its state. An expired claim lets another gateway finish an interrupted cleanup. A heartbeat that finds its registration missing restores local state. A heartbeat that finds the identity marked dead registers a new identity and also schedules cleanup of the retired identity.

A Redis error never closes a socket. The current lease renewal does close sockets on error, and the new design removes that behavior.

Every ten minutes a gateway writes its active users once more. The write is idempotent and publishes only if account state changes. This repairs presence that a Redis failover rolled back while the gateway registration survived. Each gateway keeps a presence index of the users it may mark online. A user enters the index before going online and leaves it only after being cleared, so cleanup can find the dead gateway's presence fields.

The periodic refresh also clears recently offline users again in case Redis restored a gateway field. Presence reports write failures per user for retry. The tracker's Redis write lock serializes cleanup of a retired identity with pending writes, so a write under that identity cannot arrive after cleanup.

The ten-connection admission cap uses separate Redis keys. An admission holds the user's cancellable lock and the shared admission gate while Redis checks the fleet-wide count and adds the connection. The heartbeat takes the admission gate exclusively when it detects a missing or dead registration. Admissions stay blocked through re-registration and count restoration. Release updates the local count and wakes the writer, which writes the absolute count and drops zero counts from the index under the same user lock. Cleanup takes that lock before clearing counts for the dead identity. When cleaning its own retired identity, the gateway also checks its local users in case a previous cleanup deleted an index entry during an in-flight admission. If a stalled gateway is declared dead while it is admitting a connection, the cap can be exceeded by one connection until those connections close.

## Watchers

The protocol is generic and identifies users only: `presence.watch {add, remove}`, with the full set sent again after a reconnect. The gateway knows nothing about chats or sidebars.

Kotlin's `presenceVisibility(viewer, subjects)` decides, for each subject:

- the level: `full`, `coarse` or `none`;
- the durable last-seen time.

Today's rule is that the viewer shares a chat with the subject. Later rules (user settings, blocks, public profiles) change only that function.

Authorization runs only for added users, in one batched call per watch command. Removal from a chat, chat deletion, account deletion and privacy changes revoke a grant at once. A user-room event rechecks the removed user's own grants. Viewers of that user can be on any gateway and need not follow the chat, so after a removal or a group deletion the outbox publisher also sends a revocation on each affected subject's presence channel: the removed member, or every member of the deleted group. Every gateway that watches them suspends those grants, fences authorizations already in flight and checks again; pairs that still share a chat keep access. Privacy changes will use the same channel. A gateway subscribes to a user's bucket before it checks a first watch, so a revocation after that check always reaches it. An online count is the exception: its members are known only from the same read, so a count opened on a gateway not yet subscribed to their buckets can miss a revocation. The client asks for a new count on the group's membership events, and expiry covers the rest. Grants expire after 15 minutes. The gateway then reauthorizes, in one batch, the users still watched. A missed revocation is therefore bounded by 15 minutes. Coarse viewers get a snapshot without live updates. Viewers with level `none` get no bytes at all.

Each gateway keeps one in-memory table, subject → `{state, v, local watcher sockets}`. Subjects in the same bucket share one Redis subscription. The gateway waits for that subscription before reading a subject's snapshot, then keeps whichever version is higher. Every later socket that watches the same subject reads from memory. The gateway tracks the last sequence per bucket. A sequence gap makes it read the bucket's watched subjects again. A disconnect, an unsolicited `sunsubscribe` or a topology change does three things:

- marks the affected observations unknown;
- resubscribes;
- reads snapshots again at a limited rate.

Bucket resync resets subject versions so a rolled-back Redis snapshot can apply. A failed snapshot leaves subjects unknown for the next sweep to retry. Revocations carry only the lowercase `r` list of users from that bucket and do not advance its transition sequence. Under the hub mutex, a first watch replaces its in-flight add with its authorization result. A revocation can fence either state. A revocation can also fence a pending roster read whose members are not known yet. An older authorization result installs suspended and triggers a recheck. A renewal applies only to the grants it captured and schedules another pass if a recheck arrived meanwhile. The per-watch delivery mutex covers both frame construction and enqueueing to preserve order. Hidden watches still get rejected IDs.

Subjects with no watchers stay in the table for 30 seconds before removal. Outgoing presence frames are combined per socket every 100–250 ms. A subject with more than 500 local watchers is pushed at most once every three seconds, and only its latest state is sent.

A hidden tab stops receiving presence after five seconds. On focus it gets one batched catch-up, visible rows first. After five minutes hidden, the client releases its watches and adds them again on focus.

The client keeps one reference-counted store. It has a global cap of 500 distinct users and a budget per source (the sidebar gets 200). The open chat header, an open profile and the members of an open group are never evicted. When the store is over its cap, it first evicts from the source that is furthest over its budget, least recently shown first. A removal waits ten seconds before it is sent.

The sidebar watches the peers of every loaded direct chat, ranked visible first, then the next 20 rows, then the most recently shown. Loaded pages stay in memory for the session. The gateway enforces 500 distinct users per connection and rejects the excess IDs by name. A per-account rate limit (burst 30, three per second) is charged once per watch command that adds users. The client paces its presence and online count watches together at one per second, and after a rate-limit error it sends its whole watch set again.

The client asks again for refused users after a new chat arrives and retries every minute even without an event. The gateway rechecks grants it already holds, so the client must ask again to learn about newly permitted users.

### Publishing revocations

The publisher triggers revocation from the removed user's room event or the deleted group's room event. For a group deletion it reads the roster on a blocking worker and sends up to 64 bucket publications concurrently. A 100,000-member group can span all 4,096 buckets.

## Group online count

A group of up to 200 members shows "N members, M online" while the chat is open. Kotlin authorizes the viewer and returns the member IDs the viewer may see. The gateway keeps the roster private and sends a frame when either the online count or the total membership changes. An empty chat ID stops the watch. A roster refresh advances its generation to fence a response already in flight and retains the last sent count to suppress duplicates. Larger groups show only their member count. Hovering the count shows a paginated member preview, and clicking it opens the members dialog. Both show live status for their loaded rows through ordinary watches.

## Last seen

Redis `ls` keeps the exact time. Gateways also send "user seen at T" records to Kotlin in batches every five seconds, when a user goes online, when they go offline, and every ten minutes while they are active. Each user is limited to one write per minute, except that the first write after a long gap is always sent. Kotlin runs `UPDATE ... SET last_seen = GREATEST(last_seen, $t)` in batches. Writing at the 0→1 transition keeps a brief visit after a long absence visible as "recently", even after Redis loses data.

The API's default inbound gRPC limit is 8 KiB. A visibility request fits about 230 user IDs, so the gateway caps the batch at 200. A last-seen write also carries timestamps and uses a batch of 150.

Viewers with level `full` see "online" or the exact time. Everyone else sees a bucket:

- recently, within three days;
- within a week;
- within a month;
- a long time ago.

The client never renders a blank status. While its own socket is disconnected, it shows the last known value.

## Module boundary

Presence lives in `ws/internal/presence` behind `Track`, `SetActivity`, `Watch`, `Count` and `Deliver`. It has its own Redis client settings: `PRESENCE_REDIS_ADDRS` defaults to the shared cluster. Its keys use their own namespace, and no Lua script touches both presence keys and other keys. Moving presence to its own Redis cluster is a configuration change. Gateway registration and dead-gateway cleanup belong to gateway infrastructure, and both connection admission and presence attach to them.

## Considered options

- **Faster or deduplicated polling.** Rejected because the cost grows with watched users over time, not with changes.
- **Per-socket leases with a due-time sweeper per bucket.** Rejected because it keeps about 33,000 renewals per second at a million sockets and takes 60–90 seconds to show offline after a gateway crash.
- **One channel per user.** Rejected because, when clients watch every loaded chat, each gateway ends up interested in most users. That means tens of millions of Redis subscriptions, and recovery would have to resubscribe millions of channels.
- **One global channel.** Rejected because every transition would go through one Redis node.
- **An interest registry with gateway inboxes.** Rejected because every watch change would need a registry write, and the extra publish after the script is not atomic with the state change.
- **A dedicated in-memory presence service.** Not planned. It is worth building only if sharded Redis cannot sustain the transition rate.
- **A second WebSocket for presence.** Rejected because it doubles connections, and presence would then track that socket instead of the socket that carries messages.
- **A persistent online counter per group.** Rejected because every transition would update the counter of every group the user belongs to.

## Consequences

The following are removed:

- the selected-chat and sidebar presence coordinators and the `presence`, `sidebar_presence`, `watch_presence` and `unwatch_presence` frames;
- `AuthorizePresence`, the `online` sorted set and per-socket lease renewal;
- the client's validity timers, and the presence part of the 12–15 second conversation refresh.

The non-presence parts of the conversation refresh (reads, mutations and history synchronization) stay. Group activity hints from ADR 0003 move to a generic `chats.watch {chatIds}` with no presence role. The presence parts of ADR 0003 no longer apply.

Room subscriptions recover after Redis slot moves as described in [gateway ordering and lock ownership](../state-machines.md#gateway-ordering-and-lock-ownership).

Delivery, memory and CPU figures are estimates. A load test before launch must measure:

- how long reads take to recover after a primary is lost;
- how long cleanup takes for a dead gateway holding 50,000 users;
- the share of received transitions that some local socket actually wanted.

Gateways export these metrics:

- received and matched transitions;
- offline latency for each failure mode;
- recovery duration;
- deliveries per transition.

Two triggers call for further changes:

- **Recovery too slow.** If recovery misses its budget, add a capped Stream log per bucket for replaying gaps.
- **Too much wasted delivery.** If the matched share stays below 10–20% and the waste costs latency or Redis CPU, add targeted routing.

Changing the bucket count re-keys presence state, so it is a coordinated migration. More Redis shards are added by moving slots.

Deferred:

- live username and avatar updates, which use their own profile topic and never the presence channel;
- reciprocal last-seen privacy;
- coarse visibility, which must deliver its snapshot without joining live fanout so transition timing stays private;
- a server-side online count for large groups;
- unloading old sidebar pages.

Sources for these choices include Slack's view-scoped presence subscriptions, Pusher's watchlists, Centrifugo's user status, LinkedIn's delayed-offline platform, and Telegram's status buckets and limit of 200 members for counting group online status on the client.
