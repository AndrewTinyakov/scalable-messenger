# WebSocket capacity and load checks

The main workloads are idle connections and group fanout. More sockets increase retained memory, timers, membership bookkeeping and reconnect work. More group traffic increases serialization, queue accounting and network writes. Measure these workloads separately before choosing a node limit.

The gateway now shares one encoded event across recipients, keeps compact frame references in outbound and replay queues, and schedules ACK expiry only while an ACK is pending. Room membership locks are local to a room, and disconnect lookup visits only that connection's memberships. Quiet-room maintenance batches Redis position checks. Send and subscription commands use ordered, bounded workers so the physical reader can continue processing ACKs and pongs while authorization or broker confirmation waits.

Transport close and grant revocation happen before bounded Redis lease cleanup. Draining rejects new upgrades, spreads connection closure over the configured drain interval, and joins owned work before shutdown completes. SQL commit, request deduplication, publisher confirmation and membership checks keep their existing guarantees. See the [broker decision](adr/0001-messenger-broker-split.md) for delivery and recovery rules.

## Measured allocations

These are local Go microbenchmarks on an Apple M3 Pro, comparing the saved initial working tree with the implementation. Each benchmark ran once for one second. They measure the named operation, not deployed requests per second or the maximum socket count.

| Operation | Before | After |
| --- | ---: | ---: |
| Allocate a 128-item outbound queue | 41,072 B/op | 2,416 B/op |
| Decode a live Redis envelope | 13,896 ns/op | 7,913 ns/op |
| Decode a live Redis envelope, bytes | 10,005 B/op | 4,826 B/op |
| Decode a live Redis envelope, allocations | 251 allocs/op | 144 allocs/op |

The queue allocation fell by about 94%. Shared event bytes also avoid encoding the same group event separately for every recipient. Logical item and byte limits still apply to every socket even when sockets reference the same bytes.

Run the current benchmarks with:

```sh
go -C ws test ./internal/redisroom ./internal/socket \
  -run '^$' -bench 'BenchmarkDecodeLive|BenchmarkOutboundQueueAllocation' \
  -benchtime=1s -count=1
go -C ws test ./internal/room -run '^$' -bench . -benchmem
```

The room benchmarks cover group fanout, disconnect lookup and batched position sweeps. A zero-latency fake Redis store isolates room bookkeeping. Use the load tool below to measure network and broker costs.

## Deploying more gateway replicas

Compose uses one `ws` service with two replicas by default. Nginx resolves the Docker service name every five seconds and uses least connections for new upgrades. Existing sockets stay on their current gateway. Prometheus discovers every gateway through Docker DNS.

```sh
MESSENGER_WS_REPLICAS=4 scripts/dev-up.sh
```

Persist `MESSENGER_WS_REPLICAS` in `.env` for subsequent Compose runs. A command-line override also works:

```sh
docker compose up -d --scale ws=4 ws ws-proxy
```

Set `MESSENGER_WS_REPLICAS=4` when running `tests/monitoring/check.mjs` or the system tests after an explicit `--scale` override, so their expected replica count matches the deployment.

Nginx has one worker per available CPU, 65,536 worker connections and a 262,144 file descriptor limit. Proxying a socket consumes a client connection and an upstream connection. Gateways also have a 262,144 file descriptor limit. The host's file descriptor, TCP memory and port limits still need to support the chosen workload. A single load-generator host can run out of source ports before the gateways reach their limit.

The defaults are admission bounds, not measured capacity targets:

| Gateway resource | Default |
| --- | ---: |
| `WS_MAX_CONNECTIONS`, including pending upgrades | 10,000 per node |
| `WS_MAX_PENDING_UPGRADES` | 128 per node |
| `WS_MAX_ROOMS` | 100,000 per node |
| `WS_MAX_MEMBERSHIPS` | 1,000,000 per node |
| `WS_MAX_ROOMS_PER_CONNECTION` | 200 |
| `WS_QUEUE_ITEMS` / `WS_QUEUE_BYTES` | 128 / 262,144 per socket |
| `WS_PENDING_ACK_LIMIT` | 256 per socket |
| `WS_COMMAND_WORKERS` | 64 per node |
| `WS_COMMAND_QUEUE_ITEMS` / `WS_COMMAND_QUEUE_BYTES` | 4,096 / 16,777,216 per node |
| `WS_CONNECTION_COMMAND_ITEMS` / `WS_CONNECTION_COMMAND_BYTES` | 32 / 131,072 per socket |
| `WS_DRAIN_TIMEOUT` / `WS_SHUTDOWN_TIMEOUT` | 5s / 10s |

Compose exposes the connection, pending-upgrade, room, membership and drain settings through `.env`. Other gateway settings can be supplied in a Compose override's `services.ws.environment`. A user may have at most ten concurrent connections across the deployment. Lower a node's admission limits if memory, latency or broker queues rise before these defaults are reached.

Large ramps behind one source IP also hit ingress limits. Compose exposes these shared-NAT settings:

| Setting | Default | Applies to |
| --- | --- | --- |
| `MESSENGER_WS_UPGRADE_RATE` / `MESSENGER_WS_UPGRADE_BURST` | `30r/s` / `100` | WebSocket upgrades |
| `MESSENGER_TICKET_IP_RATE` / `MESSENGER_TICKET_IP_BURST` | `5r/s` / `20` | Ticket requests |
| `MESSENGER_AUTH_IP_RATE` / `MESSENGER_AUTH_IP_BURST` | `1r/s` / `10` | Registration and login |

Set them for a controlled load environment before increasing `-ramp`. For example, a 100-socket-per-second ramp needs both ticket and upgrade ingress rates to allow it. Registration is separate from the measurement period. Reuse a session manifest to avoid registering users on every run. The gateway's per-user admission checks still apply.

The existing send limiter allows 20 messages per user in a Redis one-second window. A sender scheduled at exactly 20 messages per second can cross a window boundary unevenly and receive rate-limit errors. Use 18 or fewer for delivery checks, or several distinct senders for higher group event rates.

## Preparing and reusing sessions

The load tool lives in `tests/load/ws` as an independent Go module and uses the public HTTP and WebSocket endpoints. Its package separates options and run orchestration, session provisioning, HTTP requests, socket lifecycle and recovery, workloads, reporting, metrics checks and Compose access. The module pins only its Gorilla WebSocket dependency.

The tool accepts existing sessions or can register a small set of disposable users and create a group. Session files contain credentials. The tool writes a new file with mode `0600` and refuses to overwrite an existing file.

```sh
capacity_sessions="$(mktemp -d)/sessions.json"
go -C tests/load/ws run . \
  -mode fanout -bootstrap-users 2 -save-sessions "$capacity_sessions" \
  -connections 4 -duration 5s -rate 3
```

The saved JSON has this shape:

```json
{
  "sessions": [
    {"userId": "01...", "cookie": "messenger_session=..."},
    {"userId": "01...", "cookie": "messenger_session=..."}
  ],
  "groupId": "01..."
}
```

For a larger run, prepare dedicated accounts and supply their current session cookies in this format. All accounts must belong to the group. If `groupId` is absent, the tool creates a group and adds the manifest users in bounded batches. `-group-id` overrides the manifest group. Use a dedicated group with no unrelated publishers, so the tool can verify every new SQL chat sequence. At least two distinct users are required for group workloads, and `-senders` selects distinct healthy users.

Supply endpoint flags when using alternate ports or a remote stack:

```sh
go -C tests/load/ws run . \
  -mode idle -sessions "$capacity_sessions" -connections 4 -duration 10s \
  -api-url http://localhost:18081/api \
  -ws-url ws://localhost:18082/ws -origin http://localhost:18080
```

The corresponding environment variables are `MESSENGER_API_BASE_URL`, `MESSENGER_WS_URL` and `MESSENGER_CLIENT_ORIGIN`. Run `go -C tests/load/ws run . -h` for all workload settings.

## Workload checks

Run one scenario at a time. Keep the same replica count, limits, payload size and generator placement when comparing results.

```sh
go -C tests/load/ws run . \
  -mode idle -sessions "$capacity_sessions" -connections 20 -duration 2m

go -C tests/load/ws run . \
  -mode fanout -sessions "$capacity_sessions" -connections 20 \
  -senders 2 -rate 10 -payload-bytes 4000 -duration 1m -max-messages 1200

go -C tests/load/ws run . \
  -mode slow -sessions "$capacity_sessions" -connections 20 \
  -slow-readers 2 -rate 18 -payload-bytes 4000 -duration 40s

go -C tests/load/ws run . \
  -mode reconnect -sessions "$capacity_sessions" -connections 20 \
  -rate 5 -duration 1m
```

Idle mode measures connected sockets without publishing. Fanout mode publishes group messages and checks every healthy recipient. Slow mode stops physical reads on the selected sockets after subscription while healthy readers continue. Use enough messages and duration to exercise ACK or queue limits; a short slow-reader run may fit entirely in TCP buffers. Reconnect mode interrupts half the sockets one third of the way through the run, gets new tickets and resumes delivery.

Drain mode stops one explicitly named gateway. The tool checks its Compose project and `ws` service labels first. Run it only against the intended test stack. It leaves that gateway stopped so the result includes operation with reduced capacity.

```sh
capacity_gateway="$(docker compose ps -q ws | head -n 1)"
go -C tests/load/ws run . \
  -mode drain -sessions "$capacity_sessions" -connections 20 \
  -duration 1m -compose-project messenger -drain-container "$capacity_gateway"
docker start "$capacity_gateway"
```

Messages carry a run ID and timestamp. The tool counts unique notifications only after contiguous sequence advancement, rejects gaps, and ACKs progress. Expected SQL fallback during reconnect fetches at most 100 pages of 100 messages and validates those messages through the same path. Publisher confirmations must match successful sends. Attempt reservation is atomic across senders, so `-max-messages` is a strict attempt bound.

The JSON result includes attempted and successful sends, confirmed `queued` frames, unique notifications, duplicate notifications, missing healthy deliveries, reconnects and latency histogram upper bounds. Exit status is nonzero for verification failures. Setup, measurement, SQL catch-up, socket writes and verification have bounded deadlines. Every owned reader and sender joins during cleanup. The latency histogram has a fixed number of buckets.

## Capacity workload matrix

These are measurement targets for future runs. The deployed large workloads below have not been measured. For idle runs, total connections equal the replica count times the per-node target. At least `ceil(total connections / 10)` distinct users are needed. Nginx balances new connections, so inspect per-node gauges rather than assuming an exact distribution.

| Idle target per node | Total sockets with 2 replicas | Minimum distinct users with 2 replicas |
| --- | ---: | ---: |
| 1,000 | 2,000 | 200 |
| 5,000 | 10,000 | 1,000 |
| 10,000 | 20,000 | 2,000 |

| Group recipients | Minimum distinct users | Event-rate runs |
| --- | ---: | --- |
| 1,000 | 100 | 1/s, 10/s, 50/s |
| 5,000 | 500 | 1/s, 10/s, 50/s |
| 10,000 | 1,000 | 1/s, 10/s, 50/s |

Use `-senders 1 -rate 1`, `-senders 1 -rate 10`, and `-senders 5 -rate 10` for those event rates. The same group manifest can serve multiple sockets per user, up to the ten-connection limit. Prepare the required larger manifest first; the two-user bootstrap example supports only 20 sockets.

Set `-setup-timeout` above `connections / ramp` plus authorization and provisioning time. The default ramp of three sockets per second takes about 111 minutes for 20,000 sockets, so the default 15-minute setup deadline is insufficient. For example, with ticket and upgrade ingress configured above 100 requests per second, a prepared 2,000-user manifest can use `-connections 20000 -ramp 100 -setup-timeout 10m`. Run a generator on a separate host and add generators if source ports or client CPU become limiting. Keep enough admission headroom for reconnects and pending upgrades when approaching a node's configured limit.

## Checking resource bounds and cleanup

Add `-observe-metrics -compose-project messenger` to any local Compose workload. The tool samples each gateway's private metrics through `docker exec`, with at most eight workers, 256 nodes and a five-second snapshot deadline. It samples every second during the run and checks connection, room, membership, command item/byte and aggregate outbound item/byte gauges against exported configured capacities.

```sh
go -C tests/load/ws run . \
  -mode fanout -sessions "$capacity_sessions" -connections 20 -duration 30s \
  -observe-metrics -compose-project messenger
```

The observer captures a baseline before opening sockets. After canceling, closing and joining the load clients, it waits up to `-verification-timeout` for tracked resources to return to or below that baseline. The JSON includes `metrics.cleanupVerified`, baseline, final gauges, sampled fleet peaks and failures. Use an isolated stack, because unrelated connections or publishers can change the baseline during a run.

These samples can miss short peaks. Aggregate outbound checks also do not prove each socket's individual bound; socket queue and admission race tests cover that invariant. RSS and goroutine counts are recorded for comparison, but cleanup verification uses connection, membership, room and queue gauges. The Go allocator can retain memory after connections close.

For sustained runs, use the WebSocket Grafana dashboard and Prometheus. Watch saved-event latency, publish-confirmation latency, Redis replay/SQL fallback, room fanout time, queued bytes, command backlog and slow-consumer closes alongside CPU, RSS, network traffic and broker backlog. This deployment scrapes every five seconds, so short overload bursts can still fall between samples.

## Validation and remaining measurements

The isolated two-gateway smokes used four sockets and ran with Go's race detector and metrics observation:

| Workload | Confirmed sends | Unique notifications | Result |
| --- | ---: | ---: | --- |
| Idle, 3s | 0 | 0 | All four sockets remained connected |
| Fanout, 5s at 3/s | 15 | 60 | All four readers received every message |
| Reconnect, 8s at 3/s | 22 | 88 | Two sockets reconnected and resumed delivery |
| Slow reader, 16s at 18/s | 287 | 861 | All three healthy readers received every message |

Every run reported zero errors or missing healthy notifications. Connections, rooms, memberships, command queues and outbound item/byte gauges returned to zero after joined cleanup. These small runs validate the tool and lifecycle behavior; they do not establish a production capacity limit.

Run these code checks when changing room, socket or tool concurrency:

```sh
go -C ws test -race ./internal/room ./internal/protocol ./internal/socket
go -C tests/load/ws test -race ./...
```

The system suite checks replica discovery and drain/reconnect behavior. CI also runs an observed public fanout smoke against the Compose stack.

Before raising node limits, measure long idle runs at the intended socket count, then the intended group size and event rate. Repeat with paused readers and a lost gateway. Increase the generator fleet if its CPU or source ports are limiting the result. Record the first limiting resource and keep admission headroom below it.

Pub/Sub remains one feed per Redis primary. More feed shards are a later profiling decision if dispatch saturation becomes the limiting resource. Database scaling is outside this work.

## Realistic multi-group workloads

The load tool also supports seeded `mixed` scenarios with overlapping small and large groups, an explicit active-user fraction, varied payload sizes and independently scheduled sends. It verifies each socket's chat sequences and membership-specific notification counts. Existing idle, hot-group fanout, slow-reader, reconnect and drain modes remain available. See [the workload guide](../tests/load/ws/README.md) for scenario files, bounds and reuse commands. The 1000-user example is a test configuration, not a capacity claim.
