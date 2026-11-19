# Local monitoring

The Compose deployment includes Prometheus at http://localhost:9090, Grafana at http://localhost:3000, Alertmanager at http://localhost:9093 and a persistent local alert email inbox at http://localhost:8025. Ports are configurable with PROMETHEUS_PORT, GRAFANA_PORT, ALERTMANAGER_PORT and ALERT_INBOX_PORT. Grafana uses admin and GRAFANA_ADMIN_PASSWORD, defaulting to admin for local development. These ports bind only to loopback.

Start the monitoring services in the same Compose project as the application. For the browser deployment:

```sh
docker compose --env-file .env --env-file .env.browser -p messenger-browser up -d --no-deps prometheus grafana alertmanager alert-inbox cadvisor redis-exporter postgres-exporter nginx-exporter-client nginx-exporter-api nginx-exporter-ws
npm run monitoring:check
```

Prometheus discovers gateway and Kotlin worker replicas through Docker DNS and scrapes every five seconds. It retains seven days of data. Dashboard provisioning connects Grafana to this project's Prometheus. Warning and critical notifications route to separate local inbox addresses. This inbox is a development destination; production requires an externally reachable notification integration.

## Using the dashboards

Start with Messenger overview. Its compact status row shows scrape deficits, firing alerts, open sockets and saved-send volume, followed by command backlog, unpublished SQL events and acknowledgement age. Tiles and tables are snapshots at the selected range end. With To=now they show live state; an absolute historical range shows the state at that past time. Charts cover the whole selected range, so a snapshot does not describe its worst incident.

The navigation links preserve the time range when moving between overview, WebSocket delivery and SQL/broker diagnostics. Messenger database operations is available at http://localhost:3000/d/messenger-database/messenger-database and links back to these dashboards with the range preserved. Panel links open the relevant diagnostic dashboard. Prometheus targets identifies failed scrapes, while Alertmanager shows notification state. The incident table includes pending alerts before their firing delay expires.

Scrape coverage compares healthy targets with the minimum per service recorded by messenger:minimum_scrape_targets. A disappeared discovery target and a failed scrape both contribute to messenger:unavailable_scrape_targets. The local policy requires two replicas for each application role, three RabbitMQ nodes, six Redis nodes and one of each remaining configured monitoring target. These minimums allow extra healthy replicas; they do not know an external scheduler's desired replica count. Update the recording rules and corresponding replica alerts together when changing the minimum deployment policy. Scrape availability is separate from application readiness and dependency-specific health.

Product API traffic, latency and the API error alert exclude actuator routes. Prometheus scrapes therefore cannot create apparent user traffic, dilute the error ratio or satisfy its minimum product-request volume. A zero-event 5xx series displays zero only while API scrape telemetry is available. Idle histograms have no percentile; a blank latency graph does not mean zero latency. Compare request/send volume and scrape coverage before treating an empty graph as a fault. Latency legends show the maximum observed percentile over the selected range rather than presenting an old non-null observation as current.

The Container project selector applies only to overview resource charts. CPU and working set follow the newest fresh container ID for each Docker name, preventing recreations from combining old and current instances. Docker VM CPU utilization uses measured root CPU time divided by VM cores. The unsupported load-average signal and quota-dependent throttling chart are omitted from the overview. These signals describe the Linux VM, including other projects for VM CPU; they cannot establish macOS host pressure. Counts, seconds, messages per second and bytes per second have separate panels and units in the detailed dashboards.

Run npm run monitoring:check after provisioning. It verifies all twelve scrape jobs, all four dashboards, loaded links and units, query validity, live container observations without duplicate names, and coverage for every minimum-policy service. Database checks require extension readiness, successful digest/custom-query collection, Hikari acquisition/usage buckets and a healthy recorder on each Kotlin replica. They validate entry-point/outcome/phase labels, reject entry points that look like IDs, and check numeric query IDs without SQL text mappings. Publisher polling supplies query and transaction samples on idle deployments; API and processor samples may be absent until they handle work. Promtool fixtures exercise missing/down replicas, an absent service, extra replicas and API error ratios with scrape traffic.

## Database diagnosis

Database observability follows [PlanetScale Query Insights](https://planetscale.com/docs/postgres/monitoring/query-insights): PostgreSQL measures each query shape, and the application only says where a statement came from. Nothing is named per call. Repositories keep plain jOOQ code and services call `TransactionTemplate.execute` directly.

**Entry points.** A global resolver reads the Micrometer observation Spring already opened for the current work and walks to its root:

| Kind | Source | Example |
| --- | --- | --- |
| route | Spring MVC request observation, matched path template | `GET /v1/chats/{id}/messages` |
| job | `@Scheduled` task observation | `SessionCleanupScheduler.runCleanup` |
| rpc | gRPC server observation (global `ObservationGrpcServerInterceptor`) | `messenger.authorization.v1.ChatAuthorization/ValidateSessions` |
| thread | No HTTP, scheduled or RPC observation; thread name with numbers removed. Thread names are set once per executor | `outbox-publisher`, `outbox-publication`, `send-commands` |

Values are templates, never request data. Series from before this labelling have no entry point; dashboards exclude them with `entrypoint!=""`. Label cardinality stays bounded by routes, jobs, RPC methods and named threads.

**SQL comments.** One jOOQ `ExecuteListener` puts a [SQLCommenter](https://open-telemetry.github.io/opentelemetry-sqlcommenter/specifications/)-style comment at the start of every rendered statement, including each statement of a batch, for example `/*application='messenger-api',route='GET%20%2Fv1%2Fchats%2F%7Bid%7D'*/ select ...`. Leading placement keeps the tag inside PostgreSQL's 1 KiB `pg_stat_activity` capture and cannot be confused with comment markers inside inlined text. The comment appears in `pg_stat_activity` and in any slow-statement logs, so a slow or stuck statement names its endpoint. `pg_stat_statements` ignores comments when grouping, so query shapes still aggregate as before. Because one shape can now arrive with a few different comments, the API raises the pgJDBC prepared-statement cache to 1024 entries.

**Slow plans.** PostgreSQL preloads `auto_explain`, but plan logging is off by default. When enabled, logged statement text can contain values jOOQ inlines (such as message bodies in send batches), and custom plans can print bound values as constants in their predicates. `auto_explain.log_parameter_max_length=0` only suppresses the separate parameter list. Enable it only on an isolated dataset: set `POSTGRES_SLOW_PLAN_MS` (for example `250`) and recreate the container with `docker compose up -d --no-deps postgres` plus the deployment's usual Compose flags. `docker compose restart` keeps the old command and threshold.

**Application timers.** Open Messenger database operations and select the incident range. The entry-point table ranks the top fifteen entry points by accumulated query lifecycle time in that range. Concurrent calls can accumulate more seconds than the elapsed range. Mean, calls and failures use the selected range; the table's p95 and p99 use the rate interval at the range end. The entry point selector filters query panels; transaction panels follow the Kotlin service selector.

The query and transaction timers use `entrypoint_kind`, `entrypoint` and `outcome` labels, with success or failure outcomes for queries. Transaction outcomes are committed, rolled_back, failed and begin_failed. Failed completion can leave the durable outcome uncertain; a rollback is not necessarily an application error. Phase timers add begin, active, commit or rollback and use success or failure. The cumulative messenger_database_instrumentation_failures gauge counts failed recordings and should remain zero. Instrumentation does not replace SQL deduplication or determine broker acknowledgements.

| Measurement | Boundary and interpretation |
| --- | --- |
| messenger_database_query_seconds | One jOOQ lifecycle, including rendering, connection acquisition when needed, preparation, binding, execution, eager fetch and resource closing. Lazy results complete when their cursor closes. Errors before execution are included. |
| messenger_database_transaction_seconds | Actual new Spring transactions, from beforeBegin through the completion listener. Joined transactions do not add a physical transaction. Includes observed completion synchronizations and excludes later connection cleanup. |
| messenger_database_transaction_phase_seconds, begin | beforeBegin through afterBegin, including pool acquisition and JDBC transaction setup. |
| messenger_database_transaction_phase_seconds, active | afterBegin until beforeCommit or beforeRollback. Includes application work and precompletion synchronizations. |
| messenger_database_transaction_phase_seconds, commit or rollback | The corresponding listener callback pair. Commit includes observed postcommit/completion synchronizations. These are not direct JDBC commit or WAL fsync timers. |
| hikaricp_connections_acquire_seconds | Time acquiring a pooled connection. Compare p95/p99 with pending borrowers, timeout rate and active/max utilization. |
| hikaricp_connections_usage_seconds | Checkout through return to the pool. Each publisher holds a LISTEN connection, which adds one active connection and can eventually record a long usage sample. Usage is not transaction duration. |

Application histograms have explicit boundaries at 1, 5, 10, 25, 50, 100, 250 and 500 milliseconds, then 1, 2.5, 5 and 10 seconds. Histogram quantiles are estimates. Never add query, phase, pool or transaction percentiles. The metrics describe observed time, not database CPU consumption or end-to-end delivery latency. No performance improvement or overhead budget has been measured for this instrumentation.

PostgreSQL activity uses fixed JDBC ApplicationName values per application role. Activity and wait panels are scrape snapshots; five-second sampling misses short waits. The numeric custom query counts blocked client backends and active I/O/client waiters in messenger, excluding its own connection. Oldest lock-waiting query age starts at query_start and includes work before the wait. It is not exact lock-wait duration. Idle transaction age starts at xact_start. No backend PID, client address, blocker SQL or raw query text is exported by these additions.

The digest panels use pg_stat_statements execution counters and cannot produce p95/p99 or application failure counts. The pinned postgres-exporter v0.20.1 collector selects at most 25 entries by cumulative execution time and excludes entries at or below its tenth execution-time percentile. Dashboard interval rankings therefore describe the exported subset. A newly expensive statement can remain absent, and entries entering or leaving the subset can make interval totals incomplete. Exporter queries can appear in that subset. The collector omits query text and uses queryid, database and SQL role labels. Query IDs are not stable across PostgreSQL major upgrades and map to entry points only through the SQLCommenter tags in logs and pg_stat_activity. See the [pinned collector](https://github.com/prometheus-community/postgres_exporter/blob/v0.20.1/collector/pg_stat_statements.go) for its selection and PostgreSQL 17 behavior.

pg_stat_statements.max=5000 bounds server entries. The limit of 25 bounds one exporter scrape, not all distinct Prometheus series over the seven-day retention period. Watch exported-series churn, deallocation rate and the reset timestamp. Global resets and entry eviction limit interval accounting; targeted resets can affect entries without changing the global reset timestamp. Planning tracking stays disabled. The [PostgreSQL 17 extension documentation](https://www.postgresql.org/docs/17/pgstatstatements.html) describes entry eviction, reset behavior and timing fields.

## Deploying PostgreSQL observation

This change requires a PostgreSQL restart for shared_preload_libraries and a separate extension installation. Schedule the restart around running work. It preserves durability settings and existing data. The postgres-observability-init one-shot service runs deploy/postgres/observability.sql with ON_ERROR_STOP, checks preload, and installs or relocates pg_stat_statements into the observability schema in one transaction. It is safe to repeat and works with an existing data volume. Exporter startup depends on its successful completion during a normal Compose startup. An entrypoint init script alone would not upgrade an existing volume.

For the browser project, apply the restart and installation explicitly before recreating the exporter:

```sh
docker compose --env-file .env --env-file .env.browser -p messenger-browser up -d --no-deps postgres
docker compose --env-file .env --env-file .env.browser -p messenger-browser run --rm --no-deps postgres-observability-init
docker compose --env-file .env --env-file .env.browser -p messenger-browser up -d --no-deps postgres-exporter
```

Wait for PostgreSQL health before the installation command. Rebuild and roll out all Kotlin roles to enable their new timers, Hikari buckets and role names. Grafana loads the new dashboard from its existing mounted directory. The exporter connection alone uses search_path=observability,public so its unqualified built-in digest collector resolves the extension. The application and jOOQ generation keep their existing schema scope.

Run npm run monitoring:check after deployment and after the first successful scrape and publisher poll. Readiness values for preload, installation, disabled planning and digest collector success should be one. Custom-query scrape errors and application recording failures should be zero. Existing WAL counters must remain available. The schema and extension can remain installed during an application rollback; changing preload or the statement-entry limit requires another PostgreSQL restart. To disable continuous digest export, remove its collector flag and restore the exporter configuration together. Do not reset statement statistics merely to make a chart easier to read.

## Timing boundaries

Gateway command queue wait measures admission to worker pickup. Command service includes Redis send admission and confirmed Rabbit publication. Publish and processor queue delay overlap, so their percentiles must not be added. Processor queue delay starts at gateway publication, after local queue waiting. SQL chat-lock acquisition includes the database round trip and lock waiting. Transaction hold begins after the synchronized chat lookup and ends at actual transaction completion. Transaction completion measures callback return through commit or rollback. It includes transaction manager work and is not a pure WAL fsync timer.

Rabbit publisher timing separates capacity reservation, local job queue waiting, channel acquisition and wire-send-to-confirmation with messenger_ws_publish_capacity_wait_seconds, messenger_ws_publish_queue_wait_seconds, messenger_ws_publish_channel_acquisition_seconds and messenger_ws_publish_confirmation_seconds. Confirmation timing includes socket writing and worker scheduling, and follows eventual broker resolution after caller cancellation. It is not broker-only processing time. Initial channel creation occurs before metrics attachment; acquisition samples cover lazy and replacement channels.

Saved-event lag ends at gateway room handling. Device-applied latency observes still-pending live messages acknowledged as applied, with separate SQL-creation and writer-offer origins. A received_message or dismissed acknowledgement releases the notification without claiming application. Such messages do not enter the applied histogram. The pending ACK gauge and oldest age include notifications awaiting any of these release paths.

Close code and reason labels use bounded categories. Ping RTT uses matched server ping payloads. Message and byte counters cover application payloads, excluding control frames and transport overhead. Replay duration covers Redis lookup and continuity validation; catchup duration covers room join and handoff. SQL history metrics count pages, returned messages and body bytes. They cannot measure browser rendering or the full time a disconnected browser spends reconnecting before contacting the server.

cAdvisor exports container CPU, memory, network, disk I/O and CPU throttling from the Docker Linux host. On macOS this is the container VM, not macOS system-wide activity.

No user, chat, session, connection or request IDs appear as metric labels.

## Redis budgets and recovery

Each Redis node defaults to 128 MiB maxmemory with noeviction and a 256 MiB container limit. Override MESSENGER_REDIS_MAXMEMORY and MESSENGER_REDIS_CONTAINER_MEMORY together for the intended dataset. Redis also stores security/admission leases, so arbitrary key eviction is unsuitable. Exhaustion can stop writes and increase SQL outbox backlog; memory and publication alerts must remain enabled.

Recent room history targets five minutes, capped at 30,000 entries and 32 MiB of serialized event payload. Redis object overhead is additional. The first reached bound wins. At 100 small events per second, the count budget covers five minutes; larger events can reach the byte budget sooner. The one-hour idle TTL cleans up inactive keys and is separate from the busy-room retention window.

Upgrading from a stream without byte accounting resets that room's expendable Redis history and epoch on its next publication. SQL remains authoritative. Deploy publishers together rather than mixing old and new retention implementations.

Gateway replay remains bounded to 500 events. Longer gaps use paginated SQL recovery instead of allocating and enqueueing a room's entire retained history into a socket. The replay duration, fallback, SQL page volume and pending ACK metrics show the cost of this path.

## Send batching and latency checks

The send listener gathers at most sixteen physical command envelopes, with a five-millisecond assembly deadline and a one-millisecond receive timeout. Scheduler delays can extend elapsed time. MESSENGER_SEND_BATCH_SIZE selects 1 to 16; size 1 selects one command per transaction on the current implementation. MESSENGER_SEND_CONSUMERS defaults to four per processor replica, so one replica commits several chats' sends at once and MESSENGER_SEND_PREFETCH defaults to twenty. The dead-letter listener remains separate.

Each group shares one typed chat or direct-pair target and one explicit SQL transaction. Request locks are acquired in stable order before chat locks. Messages retain arrival order within each group. After a group failure returns from the transaction manager, individual fallback reacquires request locks and resolves persisted results. SQL deduplication also handles uncertain commit outcomes. Commands are acknowledged only after the actual commit; retries retain SQL deduplication. The batch-size summary counts attempted commands, including duplicates. Batch transaction counters distinguish committed, rolled-back and unknown outcomes.

Existing-chat batches share request-result lookup, chat locking, membership lookup, sequence allocation and durable writes. The sequence update checks all accepted senders' membership in SQL and advances only by the number of accepted messages. Draft-direct creation retains its existing path. Per-message transaction observations in an existing-chat batch describe the shared SQL phase after request locks, while the batch transaction timer includes request-lock acquisition. Hold and completion observations share the batch's completion point. Chat-lock acquisition has one observation per batch. Outbox anchors and their bounded group tails share one claim transaction; publication and completion remain independent across rooms.

The load tool accepts `-p95-limit 200ms` and `-p99-limit 200ms`. They fail when more than five percent or one percent of observed notifications exceed the corresponding limit, even if every message eventually arrives. Exact threshold counters are separate from histogram upper bounds, which have one-millisecond resolution through one second. See [the load-tool guide](../tests/load/ws/README.md) for bounded sampled traces and SQL recovery correlation. Run builds, test compilation and load measurements separately. Capture a clean warmup and compare equivalent workloads and resources before attributing a performance change.

PostgreSQL I/O and WAL I/O timing are enabled without changing durability settings. The pinned postgres-exporter uses its custom-query extension to expose WAL bytes, writes, synchronization counts and time from pg_stat_wal. The query takes no application input. Dashboard WAL synchronization means cover the whole database, including outbox transactions; they are not per-send commit timings. Exporter upgrades must preserve this extension or replace it, and the live monitoring check requires these series.

## Request-level profiling

The processor and publisher expose the disabled-by-default JFR event messenger.SendStage. Its custom fields are stage, requestId and eventId. It records no bodies, user IDs or credentials. Generate a minimal recording configuration with JDK 25:

```sh
jfr configure --input none --output send-stages.jfc '+messenger.SendStage#enabled=true' '+messenger.SendStage#stackTrace=false'
```

Mount that configuration into each profiling replica and temporarily supply a bounded recording flag, with a duration covering startup, warmup and measurement:

```text
-XX:StartFlightRecording=name=send,settings=/tmp/send-stages.jfc,filename=/tmp/send-stages.jfr,duration=180s,maxsize=64m,dumponexit=true
```

Copy each replica's completed recording before recreating its container. Remove profiling flags and mounts after the experiment. Parse custom events with `jfr print --json --events messenger.SendStage send-stages.jfr`. Receipt events begin at listener entry before decoding; use startTime. event_prepared joins request IDs to outbox event IDs. Transaction markers reflect actual afterCompletion status, including unknown outcomes. Preserve separate retry attempts when joining records.

Cross-process timing depends on clock alignment. An afterCompletion callback can run after another process has observed the committed row. A recipient can receive a publication before the publisher receives its Redis response. Small negative differences at those boundaries do not establish reordered delivery. Recording overhead and partial capture windows must be stated separately from unprofiled latency measurements.

## Background work and connection setup

Replay lookup timers distinguish subscribe and continuity triggers. Continuity includes live-gap repair, position reconciliation and feed restoration. Existing replay event/byte counters count recipient queue admissions during subscribe. Continuity replay counters count encoded events entering room fanout once per room item, independent of recipient count. Neither count proves device application. Replay caps and retention gaps share the gap result because Redis returns the same typed error for both.

Outbox batch timers distinguish empty, work and failed attempts. The active batch panel excludes empty polling. Stage timers measure claim and SQL commit, publication per room, and SQL completion and commit. Retained counters count rows left pending by deadline, interruption, publication failure or completion failure. Attempts can count the same row again. Redis publication success remains separate from SQL completion.

Processor timing now finishes even if broker ACK or reject fails. A separate acknowledgement counter records transport success/failure for each operation. A committed send followed by failed ACK stays committed and can be deduplicated on retry. Processing time runs from per-delivery decode start through acknowledgement attempt, including subsequent decoding and group sequencing waits. Queue arrival delay ends after each delivery is decoded and includes earlier delivery handling inside the listener.

WebSocket setup timing ends before the read loop on accepted connections, so it excludes socket lifetime. Stages are admission, connection lease, HTTP upgrade, user room join and session validation. Admission includes ticket/origin checks, local capacity and Redis rate limiting. Only entered stages record a sample. Successful stages use ready; setup result describes acceptance or a bounded failure. These metrics see requests reaching Go, not requests rejected by NGINX.

Open sockets recheck their SQL session every 4 to 6 minutes in batches of up to 100 sessions. `messenger_ws_session_checks_total` counts active, revoked and unavailable results per socket. A passing check authorizes the socket for 15 more minutes, never past session expiry. A failed RPC retries after 30 seconds and keeps the socket open. A socket closes with `session_revoked` once its session is gone, or when checks keep failing past its authorization deadline.

The database recording-failure alert warns when observations are lost while application work continues. The persistent lock alert warns when a lock-waiting query remains older than five seconds for two minutes. These are diagnostic thresholds, not product SLOs.

## Remaining monitoring and performance work

The next operational gaps are ingress status/upstream timings, per-method authorization RPC timings, browser recovery/render completion, and searchable cross-process diagnostics. The existing application stage metrics cannot follow one individual send through retries, batching and fanout. A production tracing rollout should propagate validated context through the broker and outbox, cap export queues, report drops, and define sampling, access and retention before adding a trace backend. Existing bounded JFR capture remains an incident tool.

Define separate objectives for confirmed command admission, terminal SQL result and selected-device application before adding error-budget burn alerts. Applied latency currently includes only eligible live frames acknowledged as applied; missing, disconnected, received-only and SQL-recovered frames do not enter that histogram. Keep volume, failures, pending age and telemetry coverage beside latency.

For optimization, first use the entry-point ranking to choose a concrete target. Inspect its query timing, pool wait, transaction phases, PostgreSQL waits and, on an isolated dataset, auto_explain plans logged with its tag. Use reviewed source queries and plain EXPLAIN by default; EXPLAIN ANALYZE executes statements and belongs on an isolated representative dataset for mutations. Then compare an equivalent workload with warmup, payload/fanout mix, resources, throughput, tails, errors, backlog and CPU/I/O recorded. No query/index or delivery changes were made by this observation rollout, and no speedup or instrumentation-overhead percentage is claimed.

This implementation supplies entry-point histograms, SQLCommenter tags, slow-plan logging and a limited PostgreSQL digest view. It does not supply PlanetScale's per-tag breakdown of each query shape, query-text deep dives, plan history or anomaly detection; self-hosted pg_stat_statements cannot group by comment.

## Load-test diagnosis

The SQL/broker dashboard includes outbox publication age from the persisted SQL row timestamp through each publication attempt. The SQL timestamp defaults to transaction start, so age includes work before commit and ordered waiting. It does not isolate commit-to-claim time. The Redis publication timer remains separate. Missing or future row timestamps increment the bounded invalid-age counter and do not enter the latency histogram. Observation failures do not change publication or retry behavior.

Use the existing hot-group workload and the seeded multi-group scenarios in [the load guide](../tests/load/ws/README.md). Compare the same session/group manifests, scenario seed, payload mix, offered load, resources and generator location. Recipient-weighted notification latency can amplify one slow large-group send, while broker/query histograms count commands or executions. Compare their populations and volumes before attributing a notification tail to SQL or RabbitMQ. Query-ID subset churn also makes naive subtraction of pg_stat_statements totals invalid; compare continuous entries and show churn.

The backend dashboard also plots the maximum reported quorum-queue commit latency on each RabbitMQ node. The pinned [RabbitMQ 4.3.5 collector](https://github.com/rabbitmq/rabbitmq-server/blob/v4.3.5/deps/rabbitmq_prometheus/src/collectors/prometheus_rabbitmq_raft_metrics_collector.erl) takes the maximum across current per-queue values. Values can remain unchanged on idle queues. This gauge is neither a time-window maximum nor a percentile and does not isolate fsync. Use it to correlate broker-side stalls with publisher confirmation, SQL commit and outbox-age observations.

## Chat feature diagnostics

Open the **Chat features** dashboard from any Messenger dashboard. It adds presence query sharing, authorization/snapshot failures, read-through request latency, timestamp-range write amplification, coalesced invalidations, creation-based cleanup backlog, edit/delete outcomes, mutation-to-socket latency, and bounded history/around-message query timing. Fixed operation and outcome labels keep user, chat and message IDs out of metric series.

Presence peer references and distinct targets expose how much work gateways share locally. Failed or stale observations become unknown. Connection leases expire after 90 seconds; healthy snapshots refresh every 5 seconds, so crash detection is approximate. A freshness heartbeat has an empty status diff and renews the client's 15-second observation deadline. A membership grant lasts at most 30 seconds and is reauthorized before expiry. Graceful close is observed at the next snapshot.

Read pointers survive receipt-detail cleanup. The API hides timestamps exactly 168 hours after original message creation and does not extend that age on edits or retries. Creation-day range buckets expire only after their latest possible eligible message expires, leaving up to one day of physical cleanup grace plus scheduling backlog. The backlog panel takes the maximum replica sample, capped at 10001 expired rows, and displays the oldest expired age separately. Cleanup batches use a fleet transaction lock and indexed bounded deletion. A zero backlog sample is different from missing scrape data.

Short read advances inspect at most 256 indexed message sequences and write only the creation days present. Larger advances retain the eight-range constant-work fallback. The write-amplification panel reports actual range inserts per advance. Temporary notification dedup keys expire after two minutes.

Read notification claims never wait for a different reader's uncommitted marker. A failed nonblocking transaction claim counts as coalesced and leaves that reader's durable progress independent. SQL timing for the `ReadNotificationScheduler.runPendingNotifications` entry point identifies marker contention, while the selected-chat summary refresh repairs missed hints. The [read decision](adr/0002-read-progress-and-mutable-history.md) records rollback and hash-collision behavior.

Read invalidations are limited to one per chat per 2-second bucket. Direct chats publish that invalidation to two user rooms; group chats use one group event. Selected clients also refresh summaries with jitter to repair lost or early invalidations. Reader details are lazy and paginated. First-read times mean server acceptance of a cumulative read-through declaration, not proof of individual visual attention.

The mutation lag histogram measures edit/deletion acceptance through successful socket write, including SQL commit, outbox and gateway queueing. The durable change log retains edits/deletes for seven days. An older cursor triggers bounded snapshot refresh; it never forces loading every intervening message. History benchmark results must distinguish indexed API retrieval from browser layout and from the generator's network placement.

Counters for read ranges and outcomes record repository attempts. Inspect observed SQL transaction outcomes before treating them as committed writes. Idle counters and latency histograms can be absent until the first operation. Presence-snapshot failure and expired-read-cleanup lag alerts link these symptoms to the dashboard.
