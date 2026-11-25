# Feature load driver

This Node 24 driver exercises the public HTTP and WebSocket interfaces. It leaves the original Go send-heavy benchmark unchanged. Use it against a local deployment containing the new features. It does not provision accounts, alter authentication limits, access SQL, or read server internals.

## Setup and repeatable measurement

Provide an existing private Go-driver session manifest containing `sessions: [{userId,cookie}]`. Its `mixedChats` and baseline groups are never adopted or deleted. The input must have mode 0600. Sessions must belong to disposable test accounts. No cookies appear in reports or console output.

Run from the repository root, with Node 24 on PATH:

```sh
node tests/features-load/main.mjs --phase setup \
  --manifest /tmp/messenger-features-1103/sessions.json \
  --output /tmp/messenger-features-1103/feature-topology.json \
  --users 100 --scenario mixed --seed 1103

node tests/features-load/main.mjs --phase measure \
  --manifest /tmp/messenger-features-1103/feature-topology.json \
  --report /tmp/messenger-features-1103/feature-run-a.json \
  --users 100 --scenario mixed --seed 1103 \
  --duration 120 --send-rate 2 --reconnect-fraction 0.1
```

Repeat the measure command against the same topology with another report path after changing the deployment. Preserve the driver revision, users, seed, scenario, duration, send rate and reconnect fraction. Measurement adds history and read progress, so compare the reported starting sequences and database sizes as well. This driver does not reset server state. It does not claim a comparison between its feature workload and the Go driver's different traffic model.

Setup creates its own chats and two seed messages per chat, then saves a reusable private topology and session file with mode 0600 outside the repository. Direct chats require unused account pairs. Setup stops if a planned pair already has a conversation; choose a different seed or fresh test accounts. It never deletes an existing direct chat to make room. A failed setup can leave newly provisioned chats behind. Do not run setup twice for the same account pairs. Use the saved topology for subsequent measurements.

Endpoint options are `--api`, `--ws`, and `--origin`, defaulting to the existing `MESSENGER_API_BASE_URL`, `MESSENGER_WS_URL`, and `MESSENGER_CLIENT_ORIGIN` variables or `http://localhost:8081/api`, `ws://localhost:8082/ws` and `https://messenger.localhost`. `--drain` defaults to 20 seconds. Opening sessions, subscriptions, mutable iteration targets, and disposable deletion chats finish before the measured phase. A process-wide ticket queue spaces WebSocket ticket requests by at least 250 ms, at most four requests per second, across both setup and reconnect. This respects the existing shared-host ingress limit without changing it. Opening 1,000 sessions therefore needs at least 250 seconds of setup. The admission queue retains at most 32 callers, cancels through AbortSignal, and joins its timer before shutdown. HTTP 429 responses increment explicit `ticket.rateLimited.setup` or `ticket.rateLimited.measure` counters and fail the operation. There are no ticket retries.

## Traffic

`--send-rate` is the aggregate offered messages per second, spread evenly across chats. It is deliberately low relative to connected users. A deterministic ten percent of each chat's members, rounded up, send messages. In a direct conversation that means one sender. Each socket sends a `watch_presence` reset for up to 100 peers from its selected foreground chat during warmup and after reconnect. A selected group with up to 200 members also gets a `watch_online_count` request. The driver validates `presence_config`, presence snapshots and transitions, and online counts. Other chat memberships still receive and acknowledge transport notifications.

| Scenario | Topology |
| --- | --- |
| `direct` | Disjoint two-user conversations |
| `small` | Groups of roughly eight users |
| `large` | One group containing all selected users |
| `mixed` | All three cohorts |

Payloads contain about 100 characters, with every tenth payload about 900 characters. Every fifth send replies to the chat's original anchor. Simulated foreground incoming messages dwell for 700 ms, then coalesce to one read-through maximum per second per socket. Transport ACKs are separately coalesced every 50 ms and do not call the read API. When the 32-task limit delays a read, `read.admissionDeferred` counts the admission attempt and the highest pending frontier stays retained. The drain continues posting these frontiers after the measured send interval, including the final 700 ms dwell. Any remaining frontier fails the run as `read.pendingAtEnd`; HTTP failures stay visible even when a later retry succeeds.

Every two seconds one chat gets a lazy summary, a ten-reader detail request, and one centered 50-message around-anchor request. The persistent original anchor makes the jump farther into history over repeated runs. These requests never walk intermediate pages. The driver does not populate 10K, 100K or 1M messages by itself; those history-size measurements need separately provisioned history and server query-plan evidence.

Every five seconds a mutation runs, alternating an edit and a delete of one chat's iteration target before moving to the next chat. Edits check their version and timestamp, then verify that a stale edit returns 409. Message deletion uses the unified EVERYONE endpoint, verifies completed physical removal, and requires later edits to return 404. Bodyless history hints establish observed notifications; final bounded resolve requests establish durable versions or authoritative absence. Runs need more than `5 * (2 * chat count - 1)` seconds to delete every target. A large-only run has one target, so its mutation sample is one edit and one delete; use mixed cohorts or repeated runs for a larger sample. Reports expose operation counts, so a short smoke run cannot be mistaken for exercising every feature on every chat.

At the midpoint, the configured fraction of sockets disconnects together. This initiates the reconnect burst; actual reconnect attempts share the same four-per-second ticket admission queue, with at most eight connection workers. A 100-socket burst consequently takes at least 25 seconds to reconnect, excluding HTTP/socket overhead. Large bursts can extend owned-work joining beyond the measured interval; the driver joins them before its bounded missing-notification drain. `reconnect.initiated`, `reconnect.completed`, ticket admission wait latency, and admission counters distinguish burst size from paced completion. SQL sequence catch-up and mutation revision catch-up use at most 200 pages of 100 messages each per chat. Certified sparse coverage and directional continuation allow sequence gaps and empty intermediate pages without inventing saved notifications. Mutation recovery handles UPSERT and REMOVED entries without requiring a retained message body. At 80 percent of the measured interval the driver deletes its newly created disposable group and, when an unused pair was found within 32 public lookups, its newly created disposable direct chat. Both members must then receive 404 for history. The saved benchmark topology and prior baseline chats never enter the deletion list.

## Bounds and evidence

Limits are 1,000 users, 20,000 offered sends per run, 100 aggregate sends per second, and one hour per run. The scheduler computes due sends from elapsed time without retaining a full schedule. Up to 64 due requests wait in a backlog with their original sender, body and request ID. A reconnecting or buffered socket defers its request while other sockets continue sending. `send.deferred` counts requests that waited, and `send.admissionBlockedAttempts` counts unsuccessful admission attempts. `send.schedulingLag` measures intended due time to actual socket dispatch separately from saved-notification latency. Overflow and requests still waiting at the end of the drain increment `send.dropped`, with `send.backlogOverflow` and `send.backlogExpired` recording the cause. Any drop fails the run. The report also checks exact offered/dispatched totals, even if a drop counter is absent. `send.dispatchedAfterMeasurement` identifies requests completed during the drain. Outbound socket buffering caps at 64 KiB, HTTP responses at 1 MiB, frames at 64 KiB, socket waiters at 64, and background tasks at 32. Fixed 64-bucket histograms replace latency arrays. There is no retained socket frame log. The driver retains at most 20,000 request records including the due-send backlog, and one byte per user per record to check notifications throughout the run. This deliberate bound permits exact end-of-run accounting and duplicate terminal detection, with a maximum 20 MB for notification bitmaps plus request objects and indexes.

Reports include operation counts, HTTP latency histograms, saved send-to-notification latency, live/replayed/recovered notifications, offered/dispatched/saved rates, operation and transport failures, missing accepted terminal results, missing saved notifications, optimistic-version checks, read timestamp/shape checks, peak HTTP/background concurrency, ticket queue counts, retained state counts, RSS, and heap usage. Histogram percentiles are bucket upper bounds. Saved-notification latency uses the driver's monotonic clock and includes command queueing, processing and live fanout. Recovered notifications have separate counts and do not enter the live latency histogram. HTTP histograms include failed requests and the drain/final verification work. Ticket latency includes admission wait, which also has its own histogram. Admission totals explicitly cover process lifetime including setup; ordinary measurement histograms exclude setup and phase-specific ticket counters keep setup separate.

A nonzero exit means an offered send was lost, read frontiers remain pending, an operation failed, a transport error occurred, a saved notification or accepted terminal result is missing, or a correctness check failed. Repeated Redis publication of the same saved message is counted and tolerated. One request producing distinct terminal message IDs, or both saved and rejected results, fails. Mutations check final durable versions and separately report missing observed mutation notifications. Missing live mutations during a deliberate reconnect are not alone a correctness failure because HTTP recovery is authoritative.

The selected foreground model is synthetic. This driver does not test DOM virtualization, browser focus behavior, seven-day cleanup timing, server resources, or query plans. Capture PostgreSQL, Redis, gateway, processor and read/mutation dashboards alongside each run. Server metrics and independent browser tests supply that evidence. A report contains no invented baseline or benchmark result.

Run the local checks without a server:

```sh
node --test tests/features-load/self-check.test.mjs
for file in tests/features-load/*.mjs; do node --check "$file"; done
```

The self-checks protect histogram bounds/tails, deterministic large topologies, concurrency joining, conflicting terminal detection, and shared ticket spacing, overflow, cancellation and joined shutdown, temporary send/read admission contention, scheduling lag, and failure on overload or lost offered work. They do not establish real broker, transaction or delivery guarantees. All sockets and owned background work close before normal exit. SIGINT cancels HTTP work, closes sockets, and joins owned work before reporting an interrupted run.
