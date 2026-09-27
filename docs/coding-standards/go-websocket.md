# Go WebSocket coding standards

Use these rules for the Messenger WebSocket application. Shared wire and broker rules live in [contracts.md](contracts.md); the API follows [kotlin-api.md](kotlin-api.md). Use the domain terms in [CONTEXT.md](../../CONTEXT.md).

## Origin and scope

The reference is `workers/` in `/Users/andrewtinyakov/code/pet/file-upload-system`, inspected on 2026-09-26, with HEAD `7f7aa0d1892b7bc332154a95c480af2964093b62` and local changes. Paths in the source table are relative to that repository. The source provides Go application composition, package boundaries, RabbitMQ handling, decoding, error handling, configuration, and test patterns. It has no WebSocket server or Redis implementation. Rules for sockets, rooms, and replay below are Messenger adaptations of the [selected architecture](../../research/messenger-architecture.md).

## Stack and application ownership

Keep Go modules, standard-library `context`, `net/http`, `encoding/json`, `log/slog`, `testing`, and explicit dependency construction. The reference pins Go 1.26.0, `github.com/rabbitmq/amqp091-go` 1.15.0, and `github.com/prometheus/client_golang` 1.23.2. These are observed baseline versions. Pin the WebSocket and Redis clients during implementation; neither is selected by the reference. Keep each behind a focused adapter.

Use `ws/` for the Go module and `cmd/ws-server` for the executable. Keep the repository-level Go workspace pattern if a `go.work` file is used. Do not carry over the `workers` name or the document/image processing dependencies into the socket application.

The Go application owns connections, authenticated session context, local rooms, rate-limit enforcement before enqueueing, confirmed command publication, live fanout, and bounded replay. The Kotlin API owns durable chat state, final membership validation, messages, request results, and SQL outbox processing. Go calls the API for authorization and publishes send commands; it does not become a second SQL writer.

## Package and file layout

Preserve the reference's small `cmd` composition roots and capability-based `internal` packages. Go does not need a copy of the Kotlin controller/service/repository hierarchy.

```text
ws/
  go.mod
  go.sum
  cmd/ws-server/
    main.go
    app.go
  internal/
    config/env.go, server.go, rabbitmq.go, redis.go
    socket/server.go, connection.go, reader.go, writer.go
    room/registry.go, subscription.go, fanout.go
    recovery/coordinator.go, cursor.go, replay.go
    auth/authorizer.go, session.go
    ratelimit/limiter.go
    messaging/commands.go, events.go, topology.go
    rabbitmq/connection.go, publisher.go, topology.go
    redis/connection.go, subscription.go, history.go
    apiclient/client.go, authorization.go
    messagecodec/json.go
    generated/messaging/
    generated/protocol/
    monitoring/metrics.go, server.go
```

This is an intended layout, not a requirement to create empty packages. Package ownership must remain clear as features are implemented. Keep transport-specific code in `socket`, `rabbitmq`, `redis`, or `apiclient`; keep room and replay decisions in their capability packages. Keep imports acyclic. A capability owns the interface it calls; an adapter implements it.

Follow the source's separation of `messaging` and `rabbitmq`: `messaging` knows command/event types and routes; `rabbitmq` knows channels, confirms, publication, and topology declarations. Use the same separation between room behavior and Redis operations. Avoid a generic package that hides RabbitMQ and Redis behind interchangeable `Publish` semantics.

Use lowercase package names and lower snake-case filenames. Prefer capability filenames such as `publisher.go`, `connection.go`, `validation.go`, `errors.go`, and `replay.go`. Several tightly related types can share a file. Tests sit beside the code as `publisher_test.go` or `publisher_integration_test.go`. Generated files retain generator naming.

Use about 250 lines as a handwritten production-file review signal and look for a responsibility to split before growing beyond roughly 350 lines. This is a Messenger guideline, not a source-enforced lint limit. The source divides image processing into `processor.go`, `engine.go`, `profiles.go`, and `variants.go`; its largest handwritten Go production file is 284 lines. Apply the same split to connection setup, reads, writes, room membership, and replay. Split test fixtures when they obscure test behavior; generated code is exempt.

## Interfaces, structs, and function names

Define small interfaces at the consuming package boundary when an external dependency, transport, or independently testable capability needs substitution. The reference's `worker.Runner` consumes `Consumer`, `Delivery`, `Handler`, and metrics interfaces; the RabbitMQ adapter implements the delivery boundary. `document.Processor` defines the storage operations it consumes.

Use concrete structs for the implementation and explicit constructors for validated setup. Keep constructors returning the concrete type; interfaces belong to consumers. Do not create an interface for every struct. A function dependency is enough for a single operation, following `HandlerFunc` and `CommandFunc` in the reference.

An illustrative Messenger boundary is a room authorizer consumed by the subscription code:

```go
type Authorizer interface {
    AuthorizeRoom(context.Context, Session, RoomID) (Authorization, error)
}
```

The API adapter supplies the implementation. Define only the methods this caller needs. Room membership tests can use a small fake without constructing HTTP clients or a whole application.

| Name | Convention |
| --- | --- |
| `New...` | Construct dependencies or validated state, returning an error if setup can fail |
| `Load...` | Load and validate configuration or stored data |
| `Run(ctx)` | Own a long-running lifecycle and return when stopped or failed |
| `Handle(ctx, ...)` | Process one input |
| `Publish(ctx, ...)` | Publish with the documented transport guarantee |
| `Close()` | Release resources; make ownership clear |
| `validate...` | Check input without performing application side effects |
| `Encode` / `Decode[T]` | Shared message serialization boundary |
| `Test<Subject><Behavior>` | Behavior-oriented test name |

Use `MessageID`, `UserID`, `URL`, and other Go initialisms in handwritten code. Generated `MessageId` fields are generator-owned; map them when entering handwritten types. Use descriptive receiver names such as `publisher`, `connection`, or `registry`, matching the reference. Keep implementation helpers unexported. Format with `gofmt`.

## Application composition and configuration

`main.go` creates the structured JSON logger, obtains a root context with `signal.NotifyContext`, calls `run`, and logs/exits on fatal failure. `app.go` loads configuration, creates clients and components, starts their lifecycles, and cleans up. Business logic belongs in `internal`, not `main` or `app`.

Follow `newDocumentApp` for partial-startup cleanup: if construction fails after opening a connection, close the resources already created. The application owns transport clients and shuts them down after dependent work stops. Library packages return errors; process exit belongs in `main`.

Centralize environment reads in `internal/config`. Use typed config structs, `time.Duration`, explicit units, and validation for positive sizes, concurrency, timeouts, and compatible limits. An absent variable may use a default; an invalid explicit value must fail startup. Log effective capacities and addresses without credentials.

Messenger configuration includes frame size, connection send-buffer bytes/count, replay-buffer bytes/count, room membership limits, publisher-confirm timeout, API timeout, ping/pong deadlines, room position-check interval, and shutdown timeout. Values are measured deployment settings, not hard-coded throughput claims.

## Errors, decoding, and models

Return errors with context and preserve causes using `fmt.Errorf("authorize room: %w", err)`. Classify with `errors.Is` / `errors.As`, as the reference's `PermanentError` does. Give client-visible failures stable codes; keep underlying transport details in internal logs. Log a failure at the boundary responsible for handling it rather than at every function that returns it.

Distinguish malformed input, unauthorized membership, rate limits, dependency unavailability, and publication with an unknown outcome. A confirm timeout is not proof that the command was absent from RabbitMQ. Preserve its request ID for status lookup and retry.

Use generated types only for their wire representation. Keep connection state, room membership, authorization versions, and replay progress in handwritten structs owned by the relevant package. Use explicit conversion functions and named fields instead of untyped maps passed through the application. Maps remain appropriate for keyed registries and transport metadata.

Centralize strict JSON decoding in `messagecodec`, following the reference's `DisallowUnknownFields` and single-value/EOF check. Enforce a size limit before decoding. Generated structs do not enforce every schema rule: validate required fields, identifier formats, enum values, ranges, and timestamps before acting. Optional fields must preserve absence where it has a distinct meaning. Apply the shared compatibility rules before adding fields to a strict contract.

## Concurrency and connection lifecycle

Carry over the reference's explicit context cancellation, bounded concurrency, `sync.WaitGroup`, and first-error propagation. Pass `context.Context` as the first argument to I/O and long-running operations. Every goroutine needs an owner, stop condition, and join or completion signal. Name the owner of each channel's close.

Messenger adaptation:

- Give each connection one read loop and one application write loop. Room fanout, replay, and status handlers send through the connection's bounded write queue. They do not write application frames concurrently to the socket. Keep control-frame behavior within the chosen library's documented concurrency rules.
- A connection owns its cancellation, deadlines, outbound queue, and close lifecycle. Make disconnect and room cleanup safe when read failure, write failure, and shutdown race.
- Protect shared registries with a documented mutex or owner-loop policy. Take a stable recipient snapshot before fanout; release registry locks before network I/O or blocking queue operations.
- Bound outstanding command publishes, replay work, and authorization calls. Do not start an unlimited goroutine for every recipient or broker event.
- Set read limits and write deadlines. Bound per-connection memory in bytes as well as item counts. On a slow-client overflow, mark the connection as needing recovery and close/resync it according to the protocol.
- Propagate cancellation to API, Redis, and Rabbit operations and observe deadlines while waiting for concurrency capacity. One stuck client must not stall a room.
- During shutdown, stop accepting upgrades, signal existing connections, drain only within a deadline, cancel remaining work, join goroutines, and close adapters. Explicitly track upgraded sockets; an HTTP-server shutdown alone does not finish their lifecycle.

## Rooms, command publication, and recovery

The architecture in [contracts.md](contracts.md) defines the guarantees. Implement the Go ownership rules below around those guarantees.

Authorize a session before admitting it and authorize group membership before joining a room. Bind the user room to the authenticated user. Preserve membership versions or expiry so reauthorization and revocation can remove stale access. A missed Pub/Sub revocation must not grant access indefinitely.

Maintain `room -> local connections` and a local listener count. Establish one Redis subscription for the first listener and release it after the last listener leaves. Coordinate subscribe/unsubscribe races so one connection leaving cannot unsubscribe another active connection. Different WS nodes subscribe independently.

Validate message structure and local limits before publication; enforce the shared per-user limit too. Pass the same request ID into the generated Rabbit command on every retry. The command publisher selects the partition through the shared routing contract and emits `queued` only after successful routing and confirmation.

The reference publisher serializes access to a channel and tracks a pending confirmation after cancellation so a late return cannot be mistaken for the next publication's result. Preserve this behavior and its regression tests. If throughput needs a publisher pool or multiple in-flight confirms, retain correct per-publication correlation and bound concurrency.

Keep replay coordination separate from socket reads and raw Redis operations:

1. Authorize the room, establish and acknowledge the live subscription, then buffer live events while replay is evaluated.
2. Check the room epoch and retained prior Stream entry. Read a bounded complete gap and merge it with buffered live events, deduplicating stable event/message IDs.
3. If completeness cannot be established, return `recovery_failed` and direct the client to SQL history through the API. Buffer overflow takes this same explicit recovery path.
4. Track device-applied positions separately from node-received positions. A successful write is not an application acknowledgement.
5. Mark rooms stale when the Redis link fails, even while browser sockets remain open. Recover subscriptions and positions after reconnect. Periodic room-node checks must also cover a quiet missed final event.

Use per-room position checks, batched where possible, with jitter and bounded parallelism. The existing design also requires SQL catch-up on reconnect and chat open; Redis-tail checks cannot discover a SQL-saved event whose Redis publication disappeared after outbox completion. Keep this limitation visible in code comments and tests that describe recovery guarantees.

## Monitoring and testing

Inject a Prometheus registry, as the reference does, so tests do not share global collectors. Keep metrics registration in `monitoring`. Measure active connections, active room-node subscriptions, queued bytes, slow-client closes, publish-confirm latency, replay outcomes, SQL fallback, and stale-room detection. Use bounded labels such as result and operation. IDs belong in diagnostic logs, not metric labels.

Use standard-library `testing` and focused fake structs or function adapters. Use table-driven `t.Run` cases for decoding, limits, configuration, and state transitions. Call `t.Helper` in shared test helpers, `t.Cleanup` for owned resources, and use `t.TempDir` for files. Match the source's `got` / `want` failure messages.

Use explicit channels, barriers, cancellation, and bounded timeouts to coordinate concurrency tests. Run the race detector. Test behavior and resource cleanup rather than sleeping until an assumed timing window passes.

Required behavior coverage as each capability is implemented:

- Malformed, oversized, missing-field, invalid-enum, and trailing-JSON frames; Kotlin/Go contract fixture compatibility.
- Confirm success, rejection, unroutable publication, confirm timeout, and a cancelled publication followed by a late broker response and another publish.
- Multiple local sockets sharing one subscription, first/last-listener races, disconnect cleanup, and membership revocation.
- A slow client alongside a healthy client; bounded queues, write timeout, and resync behavior.
- Live events arriving during replay, duplicate events, changed epochs, trimmed history, replay overflow, and SQL fallback.
- Redis disconnection with browser sockets still open, a quiet missed final event, reconnect storms, and cancellation during recovery.
- Startup failure after partial construction and shutdown with active sockets and pending I/O.

Keep broker tests beside adapters as `*_integration_test.go`. Follow the source's `RABBITMQ_TEST_URL` environment gate and add a Redis test endpoint when implemented. The suffix does not skip a test automatically: gate it explicitly for local unit runs, and supply real dependencies in CI. Tests requiring sharded Pub/Sub or Redis Cluster slot behavior need a matching Redis topology; a fake cannot establish those guarantees.

Once `ws/` exists, run from the repository root:

```sh
go -C ws fmt ./...
go -C ws vet ./...
go -C ws test -race -count=1 ./...
go -C ws build ./cmd/ws-server
```

Run integration tests with the configured broker endpoints and the system scenarios in [contracts.md](contracts.md). Report skipped dependency tests as skipped. The reference already uses vet and race tests in CI; WebSocket load/failure scenarios are additions for this project.

## Source examples

| Pattern | Files inspected in the reference repository |
| --- | --- |
| Small executable and explicit wiring | `workers/cmd/document-worker/main.go`, `app.go`, `workers/cmd/image-worker/app.go` |
| Caller-owned interfaces and lifecycle | `workers/internal/worker/runner.go`, `handler.go`, `preparation.go` |
| Error classification and wrapping | `workers/internal/worker/errors.go`, `workers/internal/objectstore/source.go` |
| Validated environment configuration | `workers/internal/config/env.go`, `worker.go`, `document.go`, `image.go` |
| Domain routes vs transport | `workers/internal/messaging/topology.go`, `events.go`, `workers/internal/rabbitmq/*` |
| Strict codec and generated enums | `workers/internal/messagecodec/json.go`, `json_test.go`, `contracts/generate-models.mjs` |
| Focused capability files | `workers/internal/image/processor.go`, `engine.go`, `profiles.go`, `variants.go` |
| Concurrency and integration tests | `workers/internal/worker/runner_test.go`, `workers/internal/rabbitmq/publisher_integration_test.go`, `consumer_integration_test.go` |
| Injectable metrics and process coordination | `workers/internal/monitoring/metrics.go`, `metrics_test.go`, `server.go` |
| Existing check workflow | `.github/workflows/message-contracts.yaml` |
