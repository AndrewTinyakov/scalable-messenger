---
status: proposed
---

# Gateway-owned presence with bucketed transition channels

This replaces the polling presence design. Under that design, every gateway polled Redis every five seconds for each watched user, twice when a user was both the selected chat peer and a sidebar peer. Every watcher got a frame every five seconds, whether or not anything changed. Each socket renewed a Redis lease every 30 seconds, and every watch was reauthorized over gRPC and SQL every 12–25 seconds. At one million sockets, that is roughly 33,000 lease scripts, 200,000–400,000 frames and 100,000 authorizations per second while nobody's status changes.

The new design does no work when nothing changes. Gateways already know which sockets they hold, so they write to Redis only when their local count for a user changes. Redis publishes only account-level transitions. Watchers receive only those transitions, for users they are allowed to see.

## Online, activity and timing

A connection is **active** while its tab is visible and receiving input. The client reports only transitions. It becomes idle after five seconds hidden or unfocused, or after 30 seconds without input, and becomes active again on focus or input. These thresholds come from the server in the handshake, so they can change without a client release. A user is online while at least one of their connections is active, on any device.

When a gateway's last active connection for a user goes away, the gateway waits a two-second grace period before writing. A reload or quick reconnect within that window publishes nothing. Gateways ping sockets every 20 seconds and close a socket after 40 seconds without a pong. A lost network therefore shows offline within about 45 seconds. A clean close shows offline in about two seconds, and a crashed gateway within about 15 seconds.

## Publisher state

Each user belongs to one of 4,096 buckets. One versioned `bucket(userId)` function, shared by Go and Kotlin and checked by golden test vectors, assigns the bucket. A generated tag table spreads buckets evenly across cluster slots. A user's state is the hash `presence:{b}:u:<userId>`. It holds one field per gateway epoch for that gateway's active and established connection counts, plus the version `v` and the last-seen time `ls`.

A gateway writes absolute counts, never increments, so retries and rewrites are idempotent. A Lua script computes the account state. On a transition it does three things:

- sets `v = max(v + 1, Redis TIME in microseconds)`;
- increments the bucket sequence;
- publishes `{userId, v, seq, state, lastSeen}` with `SPUBLISH presence:{b}`.

The hash, the sequence counter and the channel share a hash tag, so the write and the publish are atomic. Versions keep rising after a failover that loses writes, which matters because watchers drop versions lower than the last one they saw.

Gateways register in a `presence:gateways` sorted set and heartbeat every five seconds. When a gateway's deadline passes, the other gateways race for a `SET NX` lock on its epoch. The winner marks the epoch dead and removes its fields for every user listed in that gateway's user set, which publishes offline wherever a total reaches zero. A gateway that finds its epoch marked dead registers under a new epoch and rewrites its users. It does the same after a Redis failover or topology change.

A Redis error never closes a socket. The current lease renewal does close sockets on error, and the new design removes that behavior.

The ten-connection admission cap stays separate from presence. It uses its own gateway-owned counts, `conn:{h}`, written by one script on connect and one on disconnect. Presence can therefore move to its own Redis cluster without handshakes depending on it.

## Watchers

The protocol is generic and identifies users only: `presence.watch {add, remove}`, with the full set sent again after a reconnect. The gateway knows nothing about chats or sidebars.

Kotlin's `presenceVisibility(viewer, subjects)` decides, for each subject:

- the level: `full`, `coarse` or `none`;
- the durable last-seen time.

Today's rule is that the viewer shares a chat with the subject. Later rules (user settings, blocks, public profiles) change only that function.

Authorization runs only for added users, batched per gateway tick. Removal from a chat, chat deletion, account deletion and privacy changes revoke a grant at once. User-room events carry most revocations, and a `policy_changed` event on the subject's presence channel carries privacy changes. Grants expire after 15 minutes. The gateway then reauthorizes, in one batch, the users still watched. A missed revocation is therefore bounded by 15 minutes. Coarse viewers get a snapshot without live updates. Viewers with level `none` get no bytes at all.

Each gateway keeps one in-memory table, subject → `{state, v, local watcher sockets}`. It subscribes to the subject's bucket before reading the snapshot, then keeps whichever version is higher. Every later socket that watches the same subject reads from memory. The gateway tracks the last sequence per bucket. A sequence gap makes it read the bucket's watched subjects again. A disconnect, an unsolicited `sunsubscribe` or a topology change does three things:

- marks the affected observations unknown;
- resubscribes;
- reads snapshots again at a limited rate.

Subjects with no watchers stay in the table for 30 seconds before removal. Outgoing presence frames are combined per socket every 100–250 ms. A subject with more than 500 local watchers is pushed at most once every three seconds, and only its latest state is sent.

A hidden tab stops receiving presence after five seconds. On focus it gets one batched catch-up, visible rows first. After five minutes hidden, the client releases its watches and adds them again on focus.

The client keeps one reference-counted store. It has a global cap of 500 distinct users and a budget per source (the sidebar gets 200). The open chat header, an open profile and the members of an open group are never evicted. When the store is over its cap, it first evicts from the source that is furthest over its budget, least recently shown first. A removal waits ten seconds before it is sent.

The sidebar watches the peers of every loaded direct chat, ranked visible first, then the next 20 rows, then the most recently shown. Loaded pages stay in memory for the session. The gateway enforces 500 distinct users per connection and rejects the excess IDs by name. The existing per-account rate limit is charged once per `add` batch.

## Group online count

A group of up to 200 members shows "N members, M online" while the chat is open. The client sends `presence.count {groupId}`. Kotlin authorizes the viewer and returns the member IDs the viewer may see. The gateway tracks those members internally and sends only `{online: M}` when M changes. A membership change invalidates the set, and the gateway resolves it again. Larger groups show only their member count. The member list is paginated and shows live dots for its loaded rows through ordinary watches.

## Last seen

Redis `ls` keeps the exact time. Gateways also send "user seen at T" records to Kotlin in batches every five seconds, when a user goes online, when they go offline, and every ten minutes while they are active. Each user is limited to one write per minute, except that the first write after a long gap is always sent. Kotlin runs `UPDATE ... SET last_seen = GREATEST(last_seen, $t)` in batches. Writing at the 0→1 transition keeps a brief visit after a long absence visible as "recently", even after Redis loses data.

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

The room subscription reader must handle a `sunsubscribe` that Redis sends on its own, and topology changes. Today it handles only `ssubscribe`, so after a slot migration a room listener can stop receiving messages without reporting an error.

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
- a server-side online count for large groups;
- unloading old sidebar pages.

Sources for these choices include Slack's view-scoped presence subscriptions, Pusher's watchlists, Centrifugo's user status, LinkedIn's delayed-offline platform, and Telegram's status buckets and limit of 200 members for counting group online status on the client.
