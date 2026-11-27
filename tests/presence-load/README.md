# Presence load benchmark

This driver measures presence alone, without messages or HTTP traffic once tickets are fetched. It opens many long-lived WebSockets that watch realistic contact lists, then measures what each build costs while nobody changes status, while people come and go, and while a gateway or Redis primary fails. It speaks both presence protocols, so one population and one schedule can run against the polling build (`legacy`, before ADR 0005) and the gateway-owned build (`current`). [Presence decision](../../docs/adr/0005-gateway-owned-presence.md) · [Message-path benchmark](../realistic-load/README.md)

## Population

`plan.mjs` rebuilds the same population from its parameters on every command: by default 16,384 users with seed 1118.

- **Direct chats.** About 50 per user, from random pairings. Nobody else has more than 100, the most one legacy sidebar watch accepts.
- **Hot subjects.** The first four users in connection order have about 1,450 direct chats each. About 1,400 of those contacts are among the first 3,500 users to connect, so each gateway holds more than 500 watchers for each hot subject at the top idle plateau.
- **Groups.** Users are split into 64-member groups by connection order. Every fifth user keeps its group open and watches the other 63 members as well.

A plateau of N sockets connects the first N users in a fixed shuffled order. Each user has one device.

Each client watches its seeded contacts with its build's protocol and cadence. The browser watches only rendered rows; these seeded watch sets are a fixed workload for comparing builds, not a replay of a session.

| | Legacy | Current |
|---|---|---|
| Direct chats | `watch_sidebar` with the chat IDs, renewed every 20–23 s | Peer IDs in one `watch_presence` per connection |
| Open group | `watch_presence {chatId, userIds}`, renewed every 12–15 s | Member IDs in the same watch, plus `watch_online_count` one second later |
| Updates | Full sidebar status every 5 s; open-chat changes every 5 s | Transitions only |

## Setup

Run each build as its own fresh Compose project, one at a time, with identical proxy limits:

| Setting | Value |
|---|---|
| WebSocket connections per IP | 20,000 |
| Upgrades | 250/s, burst 250 |
| Tickets | 200/s, burst 400 |
| Authentication | 65/s, burst 100 |

Start `ws-proxy`, `api-proxy`, `prometheus`, `monitoring-access`, `redis-exporter` and `postgres-exporter`; Compose starts their dependencies. For the legacy build, use the compose file from that revision with an override that points every built service at the legacy images, because both revisions tag their images `messenger-*:local`.

`seed` writes users, sessions, chats and memberships straight into PostgreSQL in one transaction. Creating the roughly 400,000 direct chats over HTTP would take hours. The rows are the ones both builds' authorization queries read. Each stack gets its own random session tokens. The manifest holds those tokens, so keep it outside the repository; it is written with mode 0600.

```sh
node tests/presence-load/main.mjs seed --project pl-current --api http://127.0.0.1:4081/api \
  --origin https://presence.messenger.localhost --manifest /tmp/presence-load/current-manifest.json
node tests/presence-load/main.mjs run --manifest /tmp/presence-load/current-manifest.json \
  --ws ws://127.0.0.1:4082/ws --protocol current --scenario idle \
  --prometheus http://127.0.0.1:4090 --report /tmp/presence-load/reports/current-idle.json
```

Each `run` fetches WebSocket tickets for its users before any timed window. A client reuses its ticket for every reconnect, and tickets that will expire within ten minutes are replaced once a minute. A socket that should be open but closes is reconnected with capped exponential backoff, as the browser does, until it opens or the run ends.

## Scenarios

| Scenario | What it does | Builds |
|---|---|---|
| `smoke` | 64 sockets. Fails unless every intended socket is ready, probe changes are delivered both ways in time, and a watch for a stranger is denied without revealing their status | Both |
| `idle` | 1,000, 2,000 and 3,500 sockets. At each plateau: 60 s with no changes (`quiet-N`), then 3 min while 32 actors and the four hot subjects disconnect for 20 s and reconnect (`idle-N`; hot-subject changes are labelled `hot`) | Both |
| `churn` | 1,600 sockets. Disconnect-and-reconnect cycles at 2, 10 and 25 per second in connection order, 2 min each, then at 25 per second in a seeded random order (`churn-25-shuffled`). Then activity changes at 5, 25 and 100 per second (current only): a user stops interacting for 20 s with its tab still visible, then resumes | Both |
| `quick` | 2,000 sockets: `quiet-2000` and `idle-2000` as in `idle`, then `churn-10`, `churn-10-shuffled` and `activity-25` (current only) as in `churn` | Both |
| `gateway-kill` | 1,600 sockets. `docker kill --fault-container` (a gateway). The sockets it closed are the victims; they stay offline for 150 s while the surviving gateway's watchers must see them go offline. Then they reconnect to the surviving gateway; each victim's online change is timed from its own reconnect attempt, with a 30 s deadline. Finally the failed gateway restarts | Both |
| `redis-kill` | 1,600 sockets. 64 actors cycle once per second while `--fault-container` (a Redis primary) is down for 2 min, then while it recovers | Both |
| `capacity` | 2,000, 4,000, 8,000, 12,000 and 15,000 sockets. A stage passes when at least 99% of its sockets are open and ready at the end and error frames during ramp and measurement stay within 1%; the run stops at the first failure | Both |

The full suite (every scenario on both builds) takes about 2.5 hours. For a routine check, run `smoke`, `quick` and `gateway-kill` on both builds, about 30 minutes in all.

A probe actor stays offline for 20 s, longer than the 15 s delivery deadline, and online at least 40 s between cycles, so the legacy 5 s poll has several chances to see each online period. Requested and achieved action rates are recorded in each window's `schedules`. Use one fault container per run, and name a Redis primary, not a replica (`redis-cli role`). A run whose population never becomes ready, or that fails a scenario check, lists the failures in its report and exits with status 1.

The capacity ramp stops at 15,000 because macOS has 16,384 ephemeral ports for one destination address and port.

## Measurements

Each window reports:

- **Sockets.** Intended (meant to be open), open and ready sockets at the end of the window. A socket is ready while it knows a state for every user it watches and, for a current client with its group open, has received the online count. A legacy state counts only while the poll that reported it is within its `validForMs`.
- **Watch edges.** Expected and known edges, and the coverage between them.
- **Traffic.** Frames, bytes and status entries per second, and counts by frame type, error code and close code.
- **Deliveries.** Per-watcher outcomes and latency histograms (see below).
- **Generator.** Event-loop delay and RSS. A window whose p99 event-loop delay exceeds 50 ms is marked `generator.limited`, because the load generator, not the server, may have been the bottleneck.
- **Server.** From Prometheus: gateway CPU and RSS, Redis CPU, commands and memory, API CPU, gRPC and SQL rates, and each build's presence RPCs. A gauge's mean and peak cover the whole window. A counter's mean is its average rate over exactly the window; its peak is the highest 30 s rate lying inside the window, so windows under 60 s have none. The sampled intervals are in `server.intervals`.

A delivery is measured per watcher. When an actor goes offline or online, every open watcher of that actor is counted. One that already shows the new state counts as **already shown**; every other one, including one with no known state, is armed and ends in exactly one outcome:

- **Delivered.** It reports the new state within 15 s, or within the hold time after a gateway kill.
- **Late.** It reports the new state within 45 s after the deadline.
- **Missing.** It does not report the new state within that grace, its socket closes after the deadline, or the actor changes again after the deadline.
- **Superseded.** The actor changed again before the deadline.
- **Watcher closed.** The watcher's own socket closed before the deadline.

Each outcome set also reports `scored` (delivered, late and missing) and `onTime`, delivered divided by scored. Watchers that closed and changes superseded before the deadline are left out, because they say nothing about the server. In connection order, a group's members leave within moments of each other, so many watchers close before an offline change is due; compare `onTime`, not delivered over armed. Delivery latency reports exact `p50Ms`, `p90Ms` and `p99Ms` from raw samples next to the histogram bounds.

Online latency includes the actor's WebSocket handshake.

## Limits

- **Contact lists.** 50 contacts is a modest list. The legacy sidebar cannot exceed 100, and the current client watches up to 200 sidebar rows.
- **One generator process.** The driver runs as a single process; check `generator.limited` before reading a window's server numbers as a ceiling.
- **Activity.** Legacy has no activity reporting, so the activity rows are current-only.
- **Shared Redis.** Gateway registration, sessions and rooms share the Redis cluster with presence, so Redis commands are totals, not presence alone.

## Tests

```sh
node --test tests/presence-load/*.test.mjs
```
