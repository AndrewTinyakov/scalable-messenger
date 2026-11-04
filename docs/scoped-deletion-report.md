# Scoped deletion and message interactions verification

The scoped deletion update adds personal and shared deletion, Telegram-style message actions, range selection, and durable reading locations. Personal history removal stores a member cutoff; selected personal removals merge intervals. Global history removal denies the accepted prefix immediately and physically deletes rows in bounded background transactions. Later messages survive the accepted cutoff.

## Delivered behavior

Direct participants can remove messages, history or the chat for themselves or both accounts. A group member can hide any visible message personally or remove their own messages globally; the creator can remove other members' messages and clear or delete the group globally. Mixed unauthorized global batches fail atomically. Personal history clear keeps the sidebar entry; personal chat deletion hides it until a later message. A new direct conversation after global deletion receives a new chat identity.

Message bodies open a small action menu on click and reply on double-click. Native text selection and links remain usable. The menu includes paged read times for eligible outgoing messages. A committed send has one check; human read progress has two. Selection supports fixed-intent vertical dragging outside bubble bounds, reversal, auto-scroll, cancellation and a 100-message bound. Same-author runs split at ten minutes or a day boundary, with the avatar/tail at the run's end.

Reading locations retain a message identity, decimal sequence and pixel offset for up to 100 chats, without persisted message bodies. Indexed around requests restore evicted locations. Sparse scans certify covered intervals and continue directionally, including empty intermediate pages. Request lifetime and revision checks reject pages or edit overlays that became stale during a deletion. Current SQL snapshots own quote visibility.

## Storage and recovery

Global deletion physically removes message rows. Durable outbox rows contain identity references and Redis replay streams contain bodyless recovery hints. Publishers hydrate saved bodies in bounded shared batches for ephemeral fanout. The upgrade retirement procedure converts legacy outbox rows and retires old room streams; it was exercised on the local deployment. Bodyless send-request results remain for deduplication after purge. SQL deletion does not erase WAL, backups, unacknowledged Rabbit commands, browser memory or packets already delivered.

Personal prefix clear is independent of historical message count. Arbitrary selected removals require exclusions proportional to the resulting disjoint intervals. Physical global purge is proportional to deleted rows and uses fair, locked jobs. The existing limit is 500 rows per batch and four batches per API tick, with two API replicas in these measurements.

## Verification

260 Kotlin tests passed with no failures, errors or skips, including real PostgreSQL transactions and publisher application startup with Redis. 206 client tests passed, including stale response, sparse anchor, quote overlay and state-bound regressions.15 public system/resilience checks passed on the deployed patched runtime, including processor loss, Rabbit leader failure, Redis outage/trim recovery and gateway drain. Go race checks with real Redis, load-tool race checks, vet, strict contracts, formatting, typecheck and generated models passed. Five scoped-driver self-checks passed.

The first GitHub CI run exposed shared-pool starvation in latch-based tests on its two-CPU runner and scheduled cleanup deleting fixed-clock notification fixtures. The same group-capacity timeout reproduced locally with `-XX:ActiveProcessorCount=2`. Tests now own a virtual-thread executor per method and join it on teardown; scheduled read cleanup starts after the fixture suite. Existing manual cleanup checks still run. All 208 API tests and lint then passed under two CPUs with zero skips. Production code, timeouts and correctness assertions stayed unchanged, and both focused review perspectives cleared this test-only fix.

Independent headless browser testing exercised personal/global message, batch, history and chat deletion across distinct sessions; group authorization; click/double-click/native copy; drag selection and auto-scroll; focus-only reads; variable-height A/B/A restoration; million-row reply navigation; and real held HTTP responses across deletion. The final smoke sent a message through the client and observed Sent then Read. A genuinely hidden receiver stayed unread, then posted its cumulative read 736 ms after trusted activation without click or scroll. A/B/A restored its anchor from -59.8125 px to -59.6875 px with one direct around request and 50 rendered rows. Hidden quote content stayed unavailable after accepted edit responses and a later canonical snapshot.

Three application review rounds closed the demonstrated stale-response, overlay authorization, nearest-anchor, legacy-purge and publisher-wiring defects. Both final application perspectives reported no remaining findings. Two later focused driver rounds corrected reconnect/setup ordering and distinguished physical completion from cleanup-job retirement. Both perspectives cleared those fixes. Screenshots and raw network artifacts remain local, outside Git; the observations above are the portable evidence.

Physical touch/mobile hardware, operating-system focus, long-duration browser memory, independently forced million-row body eviction, cold-cache behavior and linear scaling across fleet sizes are not established by these runs. Ten-minute grouping boundaries have source/unit coverage, without an independent exact-boundary browser run.

## Runtime and method

The shared Apple M3 Pro host has 11 logical CPUs and 36 GiB memory. Docker reports 11 vCPUs and 16,818,765,824 bytes of memory. Other applications and Docker projects remained running. The deployment had two API, two gateway, two command-processor and two outbox-publisher replicas. JVM services retained a 192 MiB heap and 768 MiB container limit, without a CPU quota. Runtime patches include Go 1.26.10, x/net 0.60.0, Rabbit 5.37.0 and Guava 33.7.2-jre. Node drivers used 24.21.0.

The [scoped deletion driver](../tests/scoped-deletion-load/README.md) used fresh disposable accounts, including two distinct sessions for one account. It seeded historical rows directly in SQL with 128-byte bodies, then exercised public HTTP/WebSocket deletion, sparse history, ordinary sends and reconnect recovery. Each warm history operation ran 20 times. There was no cache flush. Seed insertion is fixture setup, not a write-throughput benchmark, and omits historical send-request and outbox growth.

## Deletion and history measurements

| Historical messages | Clear acceptance | Physical completion | Observed purge rate | Cleanup-job retirement wait |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 6.95 ms | 2.47 s | 4,046 rows/s | 204 ms |
| 100,000 | 10.38 ms | 25.10 s | 3,984 rows/s | 855 ms |
| 1,000,000 | 19.79 ms | 257.57 s | 3,883 rows/s | 494 ms |

Completion includes public checks and 100 ms polling granularity. Every fixture ended with zero original bodies, zero purge jobs and exactly the later accepted message retained. The separate 100-ID personal batch took 31.27 ms, retained all shared message rows and stored one merged exclusion interval. The global 100-ID batch took 28.02 ms and physically removed exactly those 100 rows while preserving neighbors.

Across the run, the live group completed 585 sends and one deliberate reconnect with no missing recipient notification. The 595 recorded saved results across all functional and concurrent traffic had p50 24.97 ms, p95 47.24 ms and p99 74.01 ms. The live worker offers one sequential send every 500 ms, so backpressure can reduce its offered rate.

| Million-message API operation | Warm requests | Mean | Maximum |
| --- | ---: | ---: | ---: |
| Latest 50 | 20 | 4.29 ms | 9.25 ms |
| Older across a 90% hidden middle | 20 | 5.38 ms | 12.69 ms |
| Ascending across that middle | 20 | 4.98 ms | 8.72 ms |
| Around a hidden middle anchor | 20 | 6.22 ms | 9.27 ms |

The 100 alternating hidden intervals required 13 certified pages, including short pages under the 16-span request budget. No intermediate messages were invented or skipped. Repository-equivalent `EXPLAIN ANALYZE BUFFERS` message-span plans used `messages_conversation_sequence_unique`, returned 51 rows, removed zero rows by filter and executed in 0.50, 0.58 and 0.51 ms at the three sizes. These are controlled equivalent queries, not captured SQL traces of the HTTP calls.

The [feature driver](../tests/features-load/README.md) separately ran a 200-member foreground group for 120 seconds at two offered sends per second, with reads, replies, presence watches, lazy reader/history lookups, mutations and a 10% reconnect burst. All 240 sends and 48,000 expected recipient notifications were accounted for through live delivery or SQL recovery. It completed 22,882 read advances and all 20 reconnects, with no pending read frontier or operation error. Histogram upper bounds were 65.54 ms p95 and 131.07 ms p99 for live saved notifications; read requests were at most 32.77 ms p95 and 65.54 ms p99. These bucket bounds are not exact percentiles. This differs from the earlier five-sends-per-second feature run and is not a before/after speed comparison.

## Repeated 1000 user send comparison

The original Go send-heavy scenario was retained. All three runs used the same saved sessions and groups, `mixed-1000.json`, five connections per second during setup, a 60-second measurement, 20 aggregate offered messages per second and the same `ws-load-v2` binary. The seeded schedule produced 1,183 sends and 123,305 expected recipient notifications per run. Every run accounted for all of them with zero missing deliveries or error frames. Each candidate run connected all 1,000 sockets. The scenario mixes 100 five-member groups and five 200-member groups, with a 10% active sender fraction and 256/1,000/4,000-byte payloads.

| Run | p50 upper bound | p95 upper bound | p99 upper bound |
| --- | ---: | ---: | ---: |
| Quiet pre-change baseline | 26 ms | 212 ms | 568 ms |
| Final candidate A | 26 ms | 179 ms | 332 ms |
| Final candidate B | 26 ms | 189 ms | 340 ms |

The candidate observations improve on the one baseline sample, but the shared host, growing chat history and server dependency patches prevent a causal speedup claim. The generator binary used Go 1.26.7 in all three runs; candidate gateways used patched Go 1.26.10. Setup was excluded from notification latency. A 200 ms p99 target remains unmet. No obvious large application query, pool or lock bottleneck appeared that justified a further architecture change.

The first candidate's measured-minute query p99 estimates were under 5 ms, with send-batch transaction p99 about 20 ms and outbox-completion transaction p99 about 15 ms. Pool/lock waiters and sampled outbox backlog stayed zero. The SQL-recovery warning fired while the paced clients caught up from saved old sequence positions. Its trailing-60-second fallback increase was zero at the end of the measured minute. This warning is expected load evidence from setup, not an assertion that all monitoring stayed green throughout the campaign.

## Monitoring interpretation

The [feature dashboard](../deploy/grafana/dashboards/messenger-features.json) now exposes deletion acceptance by scope/target, purge backlog and oldest age, physical progress/retries, batch latency, visibility span-budget exhaustion and publication hydration sharing. The [alerts](../deploy/prometheus/alerts.yaml) cover stalled or aging purge work. Labels use bounded operations/outcomes, without user, chat or message IDs.

Prometheus samples during deletion showed zero lock waiters and connection-pool waiters, an empty sampled outbox backlog and no firing alert. PostgreSQL's highest trailing-one-minute sampled CPU was 0.61 core, including SQL fixture setup. The oldest sampled query reached 16.1 seconds during direct million-row fixture insertion, which itself took 25.2 seconds. That setup query is separate from the measured application operations. Purge batch work used 10.4 cumulative database seconds across the workload. The million-row purge duration follows the existing worker budget rather than a demonstrated slow query.

During the 200-user workload, the top accumulated operations were read advance and session lookup, each averaging roughly 1.5 ms or less. Sampled API CPU peaked at 0.36 core per replica, sampled outbox backlog peaked at one, pool/lock waiters stayed zero, and no alert fired. The observations do not justify changing authorization or read semantics to remove those queries. Monitoring verified all 27 required scrape targets and five dashboards; Prometheus rule tests passed.

## Reproducing and evidence

The [machine-readable results](scoped-deletion-results.json) contain sanitized counts, timings, workload settings, source identity and limits. Driver commands and fixture safeguards are in the linked READMEs. Raw reports, manifests, cookies, profiles, screenshots and network logs remain outside Git under `/tmp/messenger-deletion-1104`. They are local artifacts, not uploaded GitHub media. No benchmark fixture or generated build output is committed.

The [research](research/scoped-deletion-and-message-interactions.md), [history decision](adr/0002-read-progress-and-mutable-history.md) and [upgrade maintenance procedure](../deploy/maintenance/README.md) describe the semantics and operational requirements. Existing delivery, SQL deduplication and ACK-after-commit guarantees remain in force. Two real replicas per application role were exercised; these measurements do not establish linear fleet scaling or a vertical scaling ratio.
