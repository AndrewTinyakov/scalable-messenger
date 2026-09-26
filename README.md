# Folio Messenger

A React/Vite client and TypeScript services implementing the [Messenger architecture](research/messenger-architecture.md) and [broker ADR](docs/adr/0001-messenger-broker-split.md). Direct and bounded group conversations support multiple devices, durable history, asynchronous sends, and reconnect recovery.

## Run locally

Requires Node 22.12 or later and Docker Compose.

```sh
npm ci
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:5180. Sign in as `alice`, `bob`, or `carol` with password `messenger-demo`, or create an account. Use a separate browser profile for a second user. Cookies share a session across tabs in one profile.

The seed is optional and idempotent. It creates a direct conversation, a group, and introductory messages. `.env.example` lists service URLs and ports. Copy it to `.env` to override the server configuration. Set the matching origin when serving the client elsewhere; Vite's API/gateway proxy targets are in its config.

## Processes

| Process        | Command                     | Default address                |
| -------------- | --------------------------- | ------------------------------ |
| Client         | `npm run dev:client`        | localhost:5180                 |
| HTTP API       | `npm run start:api-gateway` | localhost:3001                 |
| WS gateway     | `npm run start:ws-gateway`  | localhost:3002                 |
| Command worker | `npm run start:worker`      | RabbitMQ consumer              |
| Outbox relay   | `npm run start:relay`       | SQL poller and Redis publisher |

PostgreSQL listens on localhost:55432, RabbitMQ on localhost:5673, and Redis on localhost:6380. Rabbit management is localhost:15673 with the local guest credentials. `npm run infra:down` stops infrastructure while preserving volumes.

For a built client behind an nginx proxy with three API gateway and three WS gateway replicas:

```sh
docker compose -f compose.yml -f compose.app.yml up -d --build
# Optional demo accounts:
docker compose -f compose.yml -f compose.app.yml exec api-gateway npm run db:seed
```

Open http://localhost:8080. nginx balances HTTP requests over all three `api-gateway` instances and WebSocket upgrades over all three `ws-gateway` instances. Sessions live in PostgreSQL and rate limits in Redis, so the proxy needs no sticky sessions. DNS refresh follows replica replacements. The proxy starts only after gateway health checks pass. During replica replacement, DNS and upstream failure tracking can briefly produce retryable HTTP errors; socket clients reconnect and recover saved history.

```sh
npm run cluster:up
npm run test:cluster
CLUSTER_FAILURE_DRILL=1 npm run test:cluster
```

The cluster check requires three distinct API instance IDs and three distinct WS instance IDs. It checks cross-instance live group messages, the sender's second socket, duplicate request handling, and SQL history. The optional failure drill stops one API container and one recipient WS container, checks continued sending and reconnect/catch-up on the surviving replicas, then restarts both containers even if an assertion fails and waits for them to become healthy. It only stops containers with the expected Messenger Compose labels. Use `CLUSTER_URL` to target a different base URL; the stop drill is for this local Docker project.

For another local size, run `docker compose -f compose.yml -f compose.app.yml up -d --scale api-gateway=5 --scale ws-gateway=5`. The check requires at least three instances. `npm run cluster:down` stops the complete stack without removing database volumes.

This configuration is a local deployment example with development credentials and HTTP. For public hosting, configure TLS, private service networks, real broker credentials, `NODE_ENV=production`, and an HTTPS `APP_ORIGIN`; production cookies are Secure.

## Message and recovery behavior

The gateway validates a send and applies local and Redis-backed sender limits. A persistent command goes to one of four bounded RabbitMQ quorum queues, selected by conversation ID. `queued` is emitted only after its publisher confirm. On uncertain confirmation, retry the same request ID.

The worker rechecks membership and commits the sequence, ULID message, request result, and room outbox events together. Duplicate requests return the original result. Only then does it acknowledge RabbitMQ. `saved` means SQL committed; `rejected` is a recorded final result.

The relay leases committed outbox rows, appends bounded Redis Stream history and publishes with sharded Pub/Sub through one Lua script. Failed rows retry with backoff. Malformed broker commands move to a bounded quorum quarantine queue only after a publisher confirm, preserving the original on quarantine failure. A crash after publication can repeat events. Clients deduplicate messages and apply contiguous SQL sequences before acknowledging them.

A gateway shares one subscription per locally active room. It buffers live events while replaying a retained same-epoch cursor. Missing history requires SQL catch-up. Clients also reconcile on reconnect, focus, conversation open, and every 15 seconds while visible. Gateway tail checks replay retained missed events, including a quiet final event; Redis disconnect notifications also request reconciliation. These intervals are implementation defaults, not measured latency guarantees.

Group membership is rechecked before socket publication and on periodic checks; removal also produces conversation-change notifications. Passwords use scrypt; session tokens are random, hashed in SQL, and sent in HttpOnly SameSite cookies. Mutation origins and WebSocket origins are checked.

## Code and verification

- `apps/client/src` uses feature-sliced layers and small components.
- `apps/server/src/db` owns SQL transactions and authorization.
- `apps/server/src/brokers` owns command acceptance and room transport.
- `packages/contracts` contains validated wire schemas.
- [Coding standards](CODING_STANDARDS.md) records the agreed defaults.

```sh
npm run typecheck
npx vitest run apps/server/test/gateway.test.ts
npm test
npm run build
npm run format:check
```

Integration tests require the local services and apply migrations. The suite also injects a missed final Pub/Sub event and verifies periodic Redis replay. Tests create unique accounts and isolated command queues. `/health` identifies API/gateway processes; the API's `/metrics` exposes saved-message count, pending outbox count, oldest pending age, and failed outbox count for local inspection.

## Deployment limits

The local RabbitMQ deployment has one node, so its quorum queues do not demonstrate replicated failover. Redis is also standalone. The implementation uses sharded Pub/Sub commands and same-slot room keys, but a Redis Cluster client topology and multi-node failure drills remain deployment work. The SQL schema is a single PostgreSQL database; the alternative Vitess/Scylla research is not part of this selected implementation.

Queue partitions, backlog, rate limit, 1,000-entry room retention, prefetch, and check intervals need load testing before production sizing. Outbox failures remain visible and retry rather than silently discarding events. Retention/cleanup for completed outbox rows, sessions, test accounts, and retained chat history needs an operating policy. This app does not include attachments, end-to-end encryption, search indexing, or billion-user sharding.
