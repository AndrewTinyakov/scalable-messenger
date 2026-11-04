# Sidebar data implementation

Branch: `feat/chat-summaries-api`. Local commits only. No push, PR, merge, visual edits, dependency edits or changes to the messenger-browser stack.

## HTTP payload

Every new-server ChatResponse includes these additions:

```ts
unreadCount: number
unreadCountCapped: boolean
activityAt: string | null
lastMessage: null | {
  id: string
  sequence: string
  senderId: string
  senderUsername: string
  createdAt: string
  bodyPreview: string
  deleted: boolean
}
```

Sequences remain decimal strings. Preview length is at most 160 Unicode characters. Removed rows do not leave summary tombstones, so returned summaries currently have `deleted: false`. `senderUsername` comes from the sender's current user row, including for group list entries whose members are empty.

The candidate window contains the newest 256 stored rows before viewer filtering. Unread counting intersects it with the account's read-through, excludes the viewer's own messages, and applies global deletion, global and personal clear cutoffs, merged personal exclusions, hidden-chat state and membership. This is equivalent to taking up to 256 newest rows above read-through for the unread calculation. A saturated unread window sets `unreadCountCapped`, even when the visible count is zero. It means the exact count may be higher; render `N+`. It is not a count clamped at 99 or an estimate from sequence subtraction.

The same materialized candidate CTE supplies the last-message preview. If all 256 candidates are hidden, lastMessage is null even if older visible history exists. A null preview must not be presented as proof that the entire history is empty. This is tested explicitly with an older visible row outside the candidate window.

The Kotlin payload generates OpenAPI, then TypeScript models. The added fields remain optional in the generated TypeScript schema for compatibility with existing local draft literals and fixtures. HTTP decoding normalizes absent legacy unread fields to zero/false; current API responses always serialize them. Directory entry updates also supply these defaults. The runtime useMessenger chat directory has these fields populated. No visual files were changed to make new properties mandatory in old literals.

## Query and activity design

One correlated, page-scoped materialized CTE per returned chat is the jOOQ equivalent of the requested lateral window. EXPLAIN confirms it executes for 101 returned/lookahead rows, after the 5,201-chat directory sort. It performs one backward seek on the existing `(chat_id, sequence)` unique index and reads at most 256 raw candidates. Visibility filtering cannot move below that LIMIT. Point lookups against merged exclusion endpoints are bounded by those candidates. List and single-chat summaries use the same query helper. There are no per-chat SQL round trips and no unread-counter writes.

Flyway V10 adds `chats.last_activity_at` and backfills it from existing message creation times. jOOQ was regenerated from the migrated isolated PostgreSQL database. Future accepted sends set a monotonic database wall-clock activity value in the existing sequence UPDATE and transaction. Wall clock avoids using an old transaction-start timestamp after a lock wait. Failed sends and rollback cannot advance the committed value.

The keyset is `(coalesce(last_activity_at, joined_at), chat_id)` descending. Membership join time supplies the empty-chat fallback. Tests cover tied activities, all pages, activity advancement and rollback. This is live pagination: concurrent activity can move a chat before a cursor. Refresh reconciles it, and client page merging deduplicates identities. It is not a frozen directory snapshot.

Incoming row refreshes replace one row and reposition it with shallow array operations. They do not sort or reconcile every chat's message history. Periodic directory reconciliation can sort the loaded directory.

## Frames and authorization

```json
{"type":"watch_sidebar","version":1,"chatIds":["<chatId>"]}
{"type":"sidebar_activity","version":1,"chatId":"<chatId>","sequence":"<decimal>"}
{"type":"sidebar_presence","version":1,"observedAt":"<ISO timestamp>","validForMs":15000,"statuses":[{"userId":"<userId>","state":"online"}]}
```

An empty watch clears the sidebar slot. A watch allows at most 100 distinct chat IDs. The existing presence rate limiter admits at most 10 watches per 10 seconds per account across gateways, shared with selected-chat presence. Unknown fields, arbitrary peer IDs in the watch, invalid identifiers, duplicate IDs and oversized lists are rejected.

`AuthorizeSidebar({session_id, chat_ids}) -> {chats:[{chat_id, peer_id, group}]}` is a single batched gRPC call. One SQL authorization query checks session expiry and current chat membership, excludes deleted/hidden chats, and derives peers only for direct chats. It does not expand a group's member list. The gateway validates returned chat identities and peer IDs. Existing selected-chat presence uses its separate slot and serial.

Grants last 30 seconds and renew after 20–25 seconds. Presence is queried in bounded batches with at most eight workers every five seconds; snapshots expire after at most 15 seconds and never outlive the grant. Missing observations and dependency errors are unknown. The client subtracts network delay from validity and expires stale values to unknown. Queued sidebar frames check the current grant before writing. Closing a connection cancels its membership; the last local watcher cancels the group feed. Owned feed and renewal goroutines are joined on shutdown.

The publisher emits one generated bodyless SidebarActivityEventV1 per saved group message on `messenger:{activity:<chatId>}:live`. Broker and socket schemas in contracts generate the Kotlin/Go broker model and vocabularies. The activity channel has no Stream or body. Gateways share one subscription per watched group and forward only to connections with that row watched. Cost is one extra publication per saved group message plus fanout to watching gateways/connections, independent of total group membership. Direct messages already reach the account room.

Sidebar memberships are bounded by `min(MaxMemberships, 100000)` references per gateway and feeds by MaxRooms. Capacity denial leaves presence unknown and directory polling available. Watch admission cannot replace selected-chat presence.

Client target changes debounce for 250 ms, deduplicate and cap at 100. Watches renew and resubscribe on every socket generation. Received group hints coalesce row refreshes with 500–2,000 ms jitter, at most 100 pending chat IDs and batches of at most 10 requests. Overflow and rows outside the watch reconcile through the existing periodic directory refresh, approximately 30 seconds while network/API service is available. SQL remains authoritative. Hints can repeat or disappear and never advance message recovery or human reads. See ADR 0003.

Every committed read advance also emits an existing reads_changed event to the advancing account's user room, independently of shared chat notification coalescing. It adds at most one actor-room event, deduplicated against existing direct-room recipients. Another device can refresh and clear a group count without opening or subscribing to its full-message room.

## useMessenger interface

Existing fields remain. Additions are:

```ts
sidebarPresence: Record<string, 'online' | 'offline' | 'unknown'>
watchSidebarPeers(chatIds: string[]): void
reconnect: { nextRetryAt: number | null }
retryNow(): void
deleteChatById(chatId: string, scope: DeleteScope): Promise<void>
clearChatHistory(chatId: string, scope: DeleteScope): Promise<void>
```

`chats` includes the fields above and refreshes from received message, mutation, history, account-read and sidebar activity events. The sidebar callback accepts group IDs too, despite its required public name. Direct peer identities come from authorized directory members; the client never sends user IDs in this watch.

`nextRetryAt` is epoch milliseconds, null when no retry is scheduled. Immediate retry cancels the wait, preserves existing backoff and cannot reopen revoked/disposed sessions or duplicate an established/connecting socket.

Arbitrary-chat deletion uses the existing scoped deletion implementation and bounded retry-ID cache. Failed requests retain IDs and successful ones release them. Unopened targets do not require selecting or fetching message history. Local human-read advances immediately clear unreadCount and its cap flag; bounded pending/frontier state prevents stale summaries from restoring the badge. Successful read commits reconcile the authoritative summary; failed requests discard pending optimism.

The redesign owner must call watchSidebarPeers with visible chat IDs, render capped counts as N+, and use unknown for absent/stale presence. Existing preview rendering can use senderUsername. No visual fallback text, CSS or markup was edited here.

## Evidence and reproduction

The isolated compose file is `docs/evidence/compose.yaml`, on ports 25457 and 26457 and subnet 10.249.57.0/24, with PostgreSQL limited to two CPUs and 768 MiB. The evidence seed has 1,088,660 retained messages in one 10,002-member group after intentional deletion gaps, 5,201 chats for one user, and 110,000 personal exclusion ranges. Other chats are direct conversations. It leaves existing application stacks alone.

`SidebarPageEvidenceTests` captures SQL from the actual JooqChatRepository through an ExecuteListener. It warms five pages, measures 60 serial repository page/member-preview calls and 60 EXPLAIN ANALYZE executions, and writes:

- `sidebar-page.sql`: the emitted main SQL, with literal test IDs.
- `sidebar-page-plan.txt`: EXPLAIN ANALYZE, BUFFERS for a page of 100 plus lookahead.
- `sidebar-large-chat-plan.txt`: the emitted single-chat query against the million-message group, showing exactly 256 candidate rows.
- `sidebar-page-measurements.txt`: measured p50/p95 and scope of timing.
- `sidebar-window-result.txt`: bounded count versus an independent exact count derived from the seed's deletion/exclusion pattern.

Warm-cache timings exclude HTTP, authentication, browser rendering and network fanout. PostgreSQL's inlined EXPLAIN query enables JIT, whose generation/emission overhead appears separately in the plan. Repository wall-clock measurements use the real bound query and include conversion and direct-member preview fetching. The window returns 86 unread candidates with capped=true while the seed-derived exact unread count is 32,992. This demonstrates why the cap flag is essential.

Reproduction commands, from the repository root:

```sh
docker compose -f docs/evidence/compose.yaml up -d --wait
```

Apply the Flyway SQL files in version order to that isolated database, then:

```sh
docker compose -f docs/evidence/compose.yaml exec -T postgres psql -U messenger -d messenger -v ON_ERROR_STOP=1 < docs/evidence/sidebar-seed.sql
JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home SIDEBAR_BENCH_DB_URL=jdbc:postgresql://localhost:25457/messenger ./kotlin/gradlew -p kotlin :api:test --tests '*SidebarPageEvidenceTests'
docker compose -f docs/evidence/compose.yaml down -v
```

The benchmark is opt-in and rejects database URLs outside localhost:25457. Ordinary CI skips this large-data test and runs the transaction and transport regression suites.

## Validation

Final local results: 215 API tests passed with the opt-in evidence test skipped in the ordinary run; that evidence test passed separately. All 38 publisher tests passed with zero skips against isolated Redis. All 227 client tests and eight contract fixture tests passed. The gateway race suite passed with real Redis transport tests enabled. Kotlin lint, client formatting/typechecking and reproducible AsyncAPI generation passed.

Final warm-cache measurements were repository page/member-preview p50 22.16 ms and p95 33.89 ms; PostgreSQL main-page EXPLAIN execution p50 38.96 ms and p95 43.66 ms. The single large-chat plan reads exactly 256 candidates using 18 shared buffer hits for the candidate seek. The final page plan sorts all 5,201 memberships before evaluating only the 101 returned/lookahead summaries.

The isolated compose project, its containers and anonymous volumes were removed after measurement. Existing messenger-browser containers were left running.

Commands used across the slices, with Java 25 and Node 26 selected locally:

- `./kotlin/gradlew -p kotlin :api:test :outbox-publisher:test` with REDIS_TEST_URL pointing to isolated Redis: API transaction/visibility/read and publisher suites passed. The optional benchmark is skipped without its explicit URL; it was also run separately against the seeded database.
- `./kotlin/gradlew -p kotlin ktlintFormat` and `ktlintCheck`: Kotlin formatting/lint. Long prose literals in new schemas/tests initially failed line-length checks and were shortened before final checks.
- `JOOQ_DB_URL=jdbc:postgresql://localhost:25457/messenger ./kotlin/gradlew -p kotlin :shared:jooqCodegen`: regenerated migrated tables.
- `OPENAPI_PORT=19089 ./kotlin/gradlew -p kotlin :api:generateOpenApiDocs`, then `npm --prefix client run generate:api`: regenerated HTTP models. The temporary API process stopped afterward.
- `node contracts/generate-models.mjs kotlin`, `go`, and `validate`: generated and validated AsyncAPI models and vocabularies. gRPC Java used the Gradle generator; Go used protoc 4.30.2 and installed protoc-gen-go/protoc-gen-go-grpc. Java generation now removes trailing whitespace reproducibly.
- `node --test contracts/fixtures.test.mjs`: shared valid/invalid shape and bound checks passed. Shared activity fixtures are consumed by Kotlin publication, Go decoding/Redis transport and TypeScript decoding.
- `REDIS_TEST_URL=redis://localhost:26457 go -C ws test -race ./...`: passed, including actual Redis activity subscription/cancellation. RabbitMQ integration remains environment-gated and was not exercised for this change.
- `npm --prefix client test`, `npm --prefix client run typecheck`, and changed-file Prettier checks: passed. Tests include reconnect deadline/manual retry, fast reconnect generation, watch coalescing, stale presence expiry, account-read hints, optimistic badge protection, unopened-chat deletion and strict summary decoding.
- `git diff --check`: passed before commits.

The verification workflow now provisions Redis, runs API/publisher transaction and publication tests, and runs the gateway with the race detector. Remote CI was not triggered because this task forbids pushing. Verification used standalone isolated Redis, not a Redis Cluster failover exercise. No full browser/redesign deployment was performed. Both correctness and repository-standard review were local; no independent reviewers were started because delegation was prohibited. No known feature work remains from the requested slices.
