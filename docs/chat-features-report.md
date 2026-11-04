# Chat features and performance verification

Implemented locally on 4 November 2026. The app runs at http://127.0.0.1:18080. Use that origin because the configured browser CORS origin is 127.0.0.1. The changes are recorded in local commits; no push or pull request was made. Benchmark logs, private test sessions and screenshots live outside the repository in `/tmp/messenger-features-1103`.

## Behavior and architecture

- Presence aggregates established connection leases across devices. Watches require current chat membership, include at most 100 peers per socket, and share distinct peer queries within each gateway. Stale or unavailable observations become unknown. Online means a connected device, not human activity; crash detection uses a 90-second connection lease and periodic snapshots.
- Read-through is a durable account-level cumulative pointer, separate from device transport ACKs. The client requires 700 ms of continuous visible, focused dwell and submits at most one cumulative advance per second per selected chat. Timestamp details record server acceptance, including batching delay. Authors can lazily page current readers of their own messages.
- Timestamp details disappear exactly 168 hours after original message creation. Creation-day intervals preserve first accepted read times without a row for every message/reader pair. Indexed, coordinated cleanup removes expired buckets in bounded batches. Physical removal can lag API expiry by one day plus cleanup backlog; frontiers persist. Storage still grows with actual accepted read advances, with at most eight ranges per large advance. It is not constant for arbitrary traffic.
- Authors can edit and delete messages with optimistic versions. Deletion keeps a sequence-preserving tombstone and clears message text and its own quote. Quotes show the referenced message's current preview or deleted state. A separate retained mutation cursor repairs edits and deletions after lost events or reconnects.
- Deleting either kind of chat removes it for everyone. Either direct participant can delete a direct chat; a group's creator can delete that group. Deleted chats reject reads, writes and authorization. A later direct conversation between the same users gets a new identity.
- Reply navigation uses an indexed around-message lookup. The client keeps the latest 50 messages pinned plus one history window of at most 200, bounded inactive previews/names/readers, and no persisted message bodies. Returning to latest preserves corrected versions across both caches.
- Existing SQL request deduplication, membership checks, message/request/sequence/outbox transactions and command ACK-after-commit remain. Sources generate HTTP, SQL, broker and gRPC models. No query library or other runtime dependency was added.

See [the research](research/presence-read-receipts-and-history.md) and [the read/history decision](adr/0002-read-progress-and-mutable-history.md). The client implementation retains the existing recovery owner and splits presentation, navigation, dwell, mutations and bounded snapshot journals into feature modules.

## Measured iterations

The tests ran on the existing shared M3 Pro host with other applications and Docker projects still running. Deployment used two API, two gateway, two command-processor and two outbox-publisher replicas. JVM services retained the existing 192 MiB heap and 768 MiB container limits. These are local observations, not a production capacity guarantee. Builds and main load measurement intervals were separated; the host was not isolated from other work.

The matched 200-user feature group ran for 90 seconds at five offered messages per second, with 100-peer presence watches, reads, replies, detail/history lookups, edits/deletes and 20 reconnects. All 450 sends and 90,000 expected recipient notifications were accounted for through live delivery or SQL recovery. Final run completed 17,552 read advances, with no pending read frontier or missing message at the end.

| Measurement | First implementation | Optimized implementation |
| --- | ---: | ---: |
| Range rows per successful read advance | 8 | 1 |
| Logical range-row bytes per advance, excluding indexes | about 960 | 120 |
| Notification-claim SQL mean | 1.640 ms | 0.007 ms |
| Read HTTP mean in the 200-user workload | 22.50 ms | 15.52 ms |

Short advances now inspect at most 256 indexed message sequences and write only creation days actually present. Large jumps retain the constant eight-day fallback. The row reduction is 87.5% for the measured same-day workload; older rows do not immediately disappear from physical disk. The notification claim now uses a nonblocking transaction advisory lock, so independent readers do not wait behind an uncommitted shared marker. The SQL unique key still enforces deduplication, and periodic summary refresh repairs missed invalidation hints.

The notification SQL comparison covers 48,913 old executions and 17,741 new executions, with observed maxima of 880 ms and 1.95 ms respectively. Latency varied between repeated shared-host runs. The intermediate storage-only runs had slower tails; the final read p99 histogram upper bound was 65.536 ms. These coarse feature-driver histogram values are bounds, not exact quantiles. The strongest repeatable improvement is the measured row-write reduction and removal of the demonstrated notification-marker contention.

A separate 100-user mixed direct/small/large workload passed all 180 offered sends, 716 expected notifications, 180 read advances, nine edits, nine message deletions, ten reconnects, 36 replies and both kinds of disposable chat deletion. The mixed profile spent most sends in direct chats; the separate large-group run supplies substantial group fanout coverage. The original Go workloads remain available unchanged beside the new [feature load driver](../tests/features-load/README.md).

| Original Go workload, 60 seconds | Saved | Notifications | Missing/errors | p95 upper bound | p99 upper bound |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 users before features | 1,174 | 62,860 | 0 | 225 ms | 500 ms |
| 200 users after features | 1,174 | 62,860 | 0 | 158 ms | 221 ms |
| 1,000 users after features | 1,183 | 123,305 | 0 | 210 ms | 519 ms |

The 200-user after-run passed the exact 200 ms p95 gate but missed p99. The 1,000-user run missed both gates, with 6,730 of 123,305 notifications over 200 ms. All sockets remained connected during that measurement and cleanup returned to its baseline. No valid pre-feature 1,000-user comparison exists in this task: the initial attempt exceeded the existing ticket admission limit during setup. The completed run paced setup at four connections per second without weakening that limit. Different connection-ramp timing and shared-host conditions prevent attributing all before/after latency differences to the feature changes.

Presence measurements showed about 20,000 socket peer references sharing roughly 202 distinct node targets. Read invalidations stayed coalesced per chat instead of broadcasting each reader/message pair. The sampled outbox backlog remained zero during the matched feature run. Query, transaction and broker timing remain visible for further diagnosis; a 200 ms p99 target has not been established on this shared machine.

## Million-message navigation and browser verification

Private groups with 10,000, 100,000 and 1,000,000 messages were seeded directly in SQL for read/navigation tests. This was not a million-message write-throughput test. Forty measured public-API requests per operation followed three warmups. Around-first retrieval in the million-message chat averaged 4.95 ms with a 9.71 ms maximum and at most 50 returned rows. PostgreSQL plans used the chat/sequence index rather than OFFSET or scanning intervening pages.

Independent browser testing clicked the million-message oldest reference with one around request, highlighted and focused its target, paged through history and returned to the pinned latest page. The observed history window stayed at 200 rendered messages and about 18.3 MB of browser heap. Mobile viewport layout and keyboard focus were exercised. Current browser evidence also covers multi-device presence, foreground reads, inactive/old-history read exclusion, seven-day detail eligibility, reply/edit/conflict/tombstone/global deletion, and mutation repair while an original message was unloaded.

Actual delayed HTTP and WebSocket delivery reproduced stale snapshot and quote-ordering races. The fixes use bounded request-scoped mutation journals, authoritative SQL catch-up for a new reply with an unloaded target, immediate transport receipt release, required-sequence retry/fallback and cross-cache version reconciliation. Tests include 257- and 501-reply coalesced bursts. Journals cap at 16 concurrent scopes and 500 distinct mutations per scope, reject overflow before installation, and release on completion/cancellation.

True browser hidden-tab behavior could not be produced by the preview environment; explicit hidden/focus/dwell tests cover the hook. Physical touch and mobile keyboard hardware were not exercised. The viewport check is not a long-duration browser leak test.

## Checks and monitoring

- 237 Kotlin tests passed, including real PostgreSQL concurrency/transaction cases and 32 outbox tests with real Redis, with zero skips in the recorded results.
- 160 client tests, TypeScript production build and formatting passed.
- Gateway Go race tests with real Redis, load-tool race tests and vet checks passed. The broker transport-cancellation integration test was not separately run against an isolated RabbitMQ; public system tests and load workloads used the real deployed broker.
- Seven public HTTP/WebSocket system tests passed. Six shared contract fixture tests and 11 load-driver self-checks passed.
- HTTP, jOOQ, AsyncAPI and gRPC regeneration reproduced all 82 captured generated files without drift. Authoritative schemas retain conditional validation while model generation uses declared property types.
- Monitoring checks verified 27 healthy scrape targets, all five provisioned dashboards and 57 valid alert/recording rules, including rule tests.

The [Chat features dashboard](http://localhost:3000/d/messenger-features) adds presence sharing/failures, read latency/write amplification/cleanup/coalescing, mutation outcomes and delivery lag, history timing and database operations. It links with the existing [Database operations dashboard](http://localhost:3000/d/messenger-database) and other Messenger dashboards. Labels use fixed operations and outcomes, not user/chat/message IDs.

Independent correctness and standards/simplicity reviews tracked demonstrated findings and fixes through a shared ledger. Both final review perspectives found no remaining must-fix. The corrected browser recheck repeated the actual delayed saved-frame and return-to-latest failure with HTTP consumption held and a continuous DOM observer; no deleted quote reappeared. Immediate RECEIVED preceded SQL completion, and repeated busy-chat reads stayed at least 1,002 ms apart. Exact frozen hashes and earlier failures remain in the evidence ledger. No full CI run, production deployment or unrelated-service failover suite is claimed.

## Local evidence

Raw reports and private manifests remain outside the repository. Public summaries:

- [review/ledger.md](/tmp/messenger-features-1103/review/ledger.md)
- [user-verification/report.md](/tmp/messenger-features-1103/user-verification/report.md)
- [user-verification/final-candidate-recheck.md](/tmp/messenger-features-1103/user-verification/final-candidate-recheck.md)
- [features-large-200-nonblocking.json](/tmp/messenger-features-1103/features-large-200-nonblocking.json)
- [features-mixed-100-final.json](/tmp/messenger-features-1103/features-mixed-100-final.json)
- [original-mixed-1000-after.json](/tmp/messenger-features-1103/original-mixed-1000-after.json)
- [final-deployed-images.json](/tmp/messenger-features-1103/final-deployed-images.json)

The local app and its monitoring stack remain running. Other Docker projects and the live gRPC credential directory were preserved. The task-owned Redis and code-generation PostgreSQL test containers were removed after final checks.
