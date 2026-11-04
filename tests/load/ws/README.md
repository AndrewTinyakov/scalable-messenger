The WebSocket load tool uses public HTTP and WebSocket interfaces. Existing `idle`, `fanout`, `slow`, `reconnect` and `drain` modes keep their original single-group behavior. `mixed` adds overlapping group chats with a repeatable offered workload.

Run commands from `tests/load/ws`. Build once before measuring, so compiler work does not overlap a workload:

```sh
go build -o /tmp/messenger-ws-load .
/tmp/messenger-ws-load -mode=mixed -scenario=scenarios/mixed-200.json \
  -bootstrap-users=200 -connections=200 -ramp=5 -duration=60s \
  -save-sessions=/tmp/mixed-200-sessions.json -p95-limit=200ms -p99-limit=200ms
```

The saved manifest contains cookies and seeded group membership. It must be a new file and is written with mode 0600. Run the same command after changing the application, replacing `-bootstrap-users` and `-save-sessions` with `-sessions`:

```sh
/tmp/messenger-ws-load -mode=mixed -scenario=scenarios/mixed-200.json \
  -sessions=/tmp/mixed-200-sessions.json -connections=200 -ramp=5 -duration=60s \
  -p95-limit=200ms -p99-limit=200ms
```

Keep the scenario, ordered sessions, connection count, duration, trace sampling and application configuration identical for before/after measurements. The seed repeats group membership, intended send times, sender choices and payload sizes. Actual send times, request IDs and new chat IDs differ. Existing chat history supplies each run's starting sequence. Use dedicated disposable users without other traffic.

The supplied scenarios all offer 20 messages/s, including users who only read:

| Scenario | Users and sockets | Small groups | Large groups | Selected active users | Offered notifications/s |
| --- | ---: | --- | --- | ---: | ---: |
| `mixed-100.json` | 100 | 20 groups of 5, 0.5 messages/s each | 2 groups of 50, 5 messages/s each | 20 | 550 |
| `mixed-200.json` | 200 | 20 groups of 10, 0.5 messages/s each | 2 groups of 100, 5 messages/s each | 40 | 1100 |
| `mixed-1000.json` | 1000 | 100 groups of 5, 0.1 messages/s each | 5 groups of 200, 2 messages/s each | 100 | 2050 |

Use the matching `-bootstrap-users` and `-connections` values for each scenario. These comparisons hold offered send rate constant. Group sizes change the notification rate explicitly. For a same-notification-rate comparison, adjust cohort rates until the reported `offeredNotificationsPerSecond` matches. Repeat the exact same scenario for a same-topology application comparison.

A scenario is one strict JSON object. `groups` contains cohorts with `count`, `members` and `messagesPerSecond` per group. `activeSenderFraction` selects a global subset of connected users. Groups contain at least one selected user, and each send chooses among selected members. Some selected users may belong to no group; `activeSenderUsers` reports the actual sender pool. The payload weights choose ASCII body sizes, including the timing prefix. Examples use 80% 256-byte messages, 18% 1000-byte messages and 2% 4000-byte messages. Direct chats are not part of this mode.

Send times follow seeded Poisson arrivals. The schedule does not wait for queued confirmations or notifications. `offeredMessagesPerSecond` is the configured mean; `scheduled / duration` is the finite run's realized offer. A schedule over `-max-messages` fails before group creation instead of truncating traffic. Existing `-senders`, `-rate` and `-payload-bytes` flags apply to the single-group modes; mixed scenarios supply those choices.

The dispatch queue holds at most 256 fixed-size send descriptors. At most 16 workers construct bodies and serialize writes through each socket's writer lock. `queueDropped`, `lateDropped` and `cancelled` count offered sends that were omitted, and any nonzero count fails the run. A queued send more than 250 ms behind its intended time is late. `maxObservedSendLag` includes worker queue delay before the socket write. Notification latency starts at the actual send attempt, so check generator lag and drops as well as latency. The worker pool is joined before verification and socket workers are joined during cleanup.

Plans support at most 10000 users, 50000 sockets, 2000 groups, 200000 user memberships or socket subscriptions, 64 group subscriptions per user and 100000 scheduled sends. The existing limit of 10 sockets per user still applies. The JSON report gives each group's members, sockets, active senders, configured rate, successful sends and expected notifications. Expected counts follow each socket's memberships. Each chat has its own sequence and recovery cursor, and each assigned subscription must be ready before measurement begins.

The original high-rate comparison remains available:

```sh
/tmp/messenger-ws-load -mode=fanout -bootstrap-users=8 -connections=8 \
  -senders=8 -rate=12.5 -payload-bytes=256 -ramp=3 -duration=60s \
  -save-sessions=/tmp/fanout-8-sessions.json -p95-limit=200ms -p99-limit=200ms
```

Use `-observe-metrics -compose-project=<project>` with either mode to retain queue-bound observations and cleanup verification.

The load tool reports notification latency as send-to-receipt upper bounds. Buckets have 1 ms resolution through one second, then retain the 2 s, 5 s, 10 s, 20 s and one-minute bounds. Longer observations report `>1m`.

`-p95-limit=200ms` retains the existing gate. `-p99-limit=200ms` enables an independent gate that allows at most one percent of measured notifications to exceed 200 ms. Both gates compare the original durations, so bucket rounding does not affect acceptance. A zero limit disables its gate.

Add `-trace-file=/tmp/baseline.ndjson` to capture diagnostic timing. The file must not exist and is created with mode 0600. `-trace-sample-every=16` selects approximately one in sixteen request IDs and records every notification for those IDs. Use `-trace-sample-every=1` to capture all requests within the same bounds. Keep the sampling setting identical when comparing runs.

Each NDJSON record contains its `kind`, `requestId`, `socket`, `observedAt` and `elapsedNanos`. Send and notification records include the body timestamp as `sentAt`. Notifications also include the existing `createdAt`, `sequence` and a `source` of `websocket` or `recovery`. Queued confirmations are separate records because they can arrive before or after notifications. Join records by request ID, then use the socket index to distinguish recipient observations. No cookies or body text are recorded.

Subtract matching `elapsedNanos` values for client-local send-to-queued or send-to-notification intervals. Those values use the client's monotonic clock. Splitting notification latency at `createdAt` requires subtracting wall-clock timestamps from different hosts. That split depends on synchronized clocks and the meaning and precision of the server's message creation timestamp. It does not identify the database commit time.

HTTP recovery responses omit `requestId`. The tool resolves sampled recovery notifications using the body's existing send timestamp and the response's existing `senderId`. A private index holds at most 100000 timestamp-and-sender keys. Sampled entries retain the real request ID; unsampled entries retain only a marker so timestamp collisions cannot be mistaken for sampled sends. Sender keys never enter the NDJSON output. `recoveryCorrelated` counts resolved notifications and `recoverySkippedUnsampled` counts intentionally omitted unsampled notifications. Missing local send metadata, invalid metadata, index overflow or repeated timestamp-and-sender keys fail trace integrity and have separate counters. A timestamp collision invalidates that key rather than guessing a request ID. Missing request IDs on live WebSocket notifications still fail verification.

Tracing retains no notification history in memory. Its queue holds at most 1024 records and the file holds at most 100000 records. Identifier and creation timestamp fields have fixed length bounds. The writer drains and closes before the final report. The JSON `trace` object reports submitted and written records, queue and file-limit drops, missing request IDs and write failures. A trace failure or dropped record fails the run, so an incomplete diagnostic cannot silently pass. `written` counts encoded records; a flush or close failure means persistence is uncertain even when that count is nonzero.

## A larger community group

`scenarios/community-200.json` uses 200 users in one group, 20 eligible senders and five offered messages per second. All connected members receive each accepted message. It separates large-group fanout from the many-chat mix and retains the same weighted payload sizes. Use a sessions-only manifest to provision it, then save a separate manifest so comparisons reuse the same group.

## Generator placement

On Docker Desktop, the native generator reaches NGINX through published host ports. That path can add latency independently of application work. Compare it with a Linux generator on the Compose network, using the same public NGINX interfaces at `http://api-proxy/api` and `ws://ws-proxy/ws`, the same configured origin, session manifest, scenario and offered load. Match Linux GOARCH to the Docker engine. Mount the executable, scenario and private session file read-only in a temporary container and remove it afterward. Report generator placement with every result. An improvement from moving the generator is a network/environment comparison, not an application speedup.

A one-process native run remains useful for local browser-path behavior. Use a separate client host for production capacity measurements. Keep builds and unrelated tests outside measurement windows, inspect late/queue-dropped/cancelled sends, and compare resource usage and correct completion alongside latency.

Mixed-mode scheduling lag is checked after acquiring the socket writer, so contention with another send or acknowledgement cannot bypass the 250 ms deadline. Cancelled or late sends are skipped and fail the run. The report separates maximum writer-lock waiting from maximum schedule lag. Send timestamps and sampled traces start after acquiring the writer, immediately before transmission preparation; generator waiting belongs to the schedule-lag diagnostics.
