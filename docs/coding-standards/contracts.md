# API and messaging contract standards

Read this when changing HTTP endpoints, WebSocket frames, RabbitMQ commands, Redis events, serialization, or generated models. Language-specific structure is defined in [kotlin-api.md](kotlin-api.md) and [go-websocket.md](go-websocket.md).

## Origin and authority

The reference is `contracts/`, the API payload/controller code, generated sources, and `.github/workflows/message-contracts.yaml` in `/Users/andrewtinyakov/code/pet/file-upload-system`, inspected on 2026-09-26. Its HEAD was `7f7aa0d1892b7bc332154a95c480af2964093b62`; the checkout had local changes. The rules preserve its two generation directions: code-first HTTP and schema-first asynchronous messages.

Messenger transport guarantees come from [CONTEXT.md](../../CONTEXT.md), the [accepted broker decision](../adr/0001-messenger-broker-split.md), and the [detailed flow](../../research/messenger-detailed-flow.md). Earlier research alternatives do not replace that decision. This document defines implementation standards; it does not claim that contracts or services have already been implemented.

## Ownership and generation direction

| Contract | Edit this source | Generated result |
| --- | --- | --- |
| HTTP | Kotlin controllers, request/response payloads, validation and springdoc annotations | `contracts/openapi.yaml`, then typed HTTP client code |
| SQL | Flyway SQL migrations | jOOQ tables, records, and database enums |
| RabbitMQ commands / events | AsyncAPI operations, channels, and referenced payload schemas | Kotlin and Go message models |
| Redis room events | Shared event schemas and Redis transport/recovery metadata | Consumer/publisher wire models |
| WebSocket protocol | Explicit frame schemas and documented protocol operations | Go and client protocol models where generation supports them |

The last two rows are Messenger additions. Reuse a business-event schema when the same event crosses transports; keep Redis cursor metadata and client-frame envelopes explicit. Public socket input and trusted internal commands may need different shapes because the server attaches verified identity. Do not let a client supply authoritative actor fields through reuse of an internal command type.

## HTTP and OpenAPI

Follow the source's code-first workflow. Controllers and `...Payloads.kt` files define the API; springdoc exports `contracts/openapi.yaml`. Do not hand-edit the generated OpenAPI document or generate the server controllers from it.

Use explicit request and response classes with camel-case JSON fields. Keep requiredness, nullability, defaults, validation, and actual serialization consistent. The source uses `@field:Schema(requiredMode = Schema.RequiredMode.REQUIRED)` for required properties, including collections that default to empty. Use Bean Validation annotations for constraints and `@Schema` where the generated contract needs information the type does not express.

Review status codes, request headers, path parameters, pagination, and `ProblemDetail` responses in the exported document. Use endpoint annotations when inference is incomplete; the source does not require a separate annotated controller interface. Authentication, rate limiting, asynchronous request status, and history cursors must appear in the public contract.

Retain a `generate:openapi` script that exports the API and regenerates client declarations. In the reference it invokes Gradle `generateOpenApiDocs` and the client's generator. The export process disables Flyway, automatic Rabbit declarations/listeners, and schedulers so documentation generation does not execute background work. Provide equivalent isolation for Messenger, including its publisher.

Source examples: `api/build.gradle.kts`, `api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/web/controller/*`, `asset/web/payload/*`, `contracts/openapi.yaml`, `client/src/api/generated/`, root and client `package.json`.

## AsyncAPI and schema layout

Preserve the reference's AsyncAPI 3 layout and JSON Schema draft-07 payloads:

```text
contracts/
  openapi.yaml
  asyncapi.yaml
  models.asyncapi.yaml
  messages.yaml
  channels/
    commands.yaml
    events.yaml
    dead-letters.yaml
    websocket.yaml
  schemas/
    message/command/send-message-v1.yaml
    message/event/message-saved-v1.yaml
    message/event/send-rejected-v1.yaml
    socket/frame/subscribe-v1.yaml
    socket/frame/applied-v1.yaml
  generate-models.mjs
```

The Messenger filenames are illustrative; choose exact wire operations while implementing their contract. `asyncapi.yaml` owns servers, channel references, and send/receive operations. Channel files own addresses and transport bindings. `messages.yaml` owns message names, content types, correlation metadata, and payload references. Individual schemas own fields and validation. `models.asyncapi.yaml` is a model-generation entry point referencing the same schemas, not a second copy of their definitions.

Use PascalCase versioned message names, such as `SendMessageCommandV1` and `MessageSavedEventV1`. Use lower-kebab-case schema filenames ending `-v1.yaml`, imperative command names, and past-tense event names. JSON properties use camel case. Domain enum and failure-code wire values are explicit; the source uses upper snake case. Preserve the Messenger's existing lower-case protocol state names `queued`, `saved`, `rejected`, and `applied`.

Declare `required`, `additionalProperties: false`, enums, ranges, patterns, and formats. Document whether an optional field is omitted or nullable. Keep identifiers and timestamps as strings with documented formats. In handwritten code, use actual time types after decoding. Specify a lossless JSON representation for chat sequences and other 64-bit values before generating browser clients; a JavaScript number cannot represent every 64-bit integer.

Use a shared canonical identifier format across schema, Kotlin, and Go validation. The reference has differing ULID regex strictness between its API user validator and worker validator. Adopt the canonical ULID range consistently instead of copying that mismatch. ULID message identity and chat sequence have different roles.

## Generated code and compatibility

Keep generated output in dedicated directories and commit it with the source change:

- `api/src/generated/java` for jOOQ.
- `api/src/generated/asyncapi/kotlin` for Kotlin message types, grouped by feature and `messaging.command` / `messaging.event`.
- `ws/internal/generated/messaging` for Go broker/event models.
- A separate generated protocol directory for client-facing socket models when needed.
- The client's generated HTTP directory once a client exists.

Preserve `validate:asyncapi`, `generate:asyncapi:kotlin`, and `generate:asyncapi:go` as repository-level scripts. The reference validates both AsyncAPI entry points, bundles schema references, generates from the model entry point, applies deterministic transformations, and formats output. Adapt the target paths and package names for Messenger.

Fix generator defects in `generate-models.mjs` or its templates, then regenerate. The reference does this for Go enum decoding so invalid strings and null values fail instead of silently choosing an enum. It also reorganizes generated Kotlin files into command/event packages. Never make a one-off manual patch to generated output.

Strict decoders reject unknown fields. An added field or enum value can therefore break an older consumer even when it appears optional. Specify a compatible rollout or introduce a new message version. Regenerate every affected language and inspect the resulting wire shapes together. A schema's constraints are not proof that a generated decoder enforces them.

Maintain shared JSON fixtures for valid and invalid messages. Cover missing required values, null versus absent, invalid enums and IDs, timestamp parsing, integer boundaries, unknown fields, and multiple JSON values. Test both producer encoding and consumer decoding. Add topology/contract agreement tests where runtime constants remain handwritten.

## Transport responsibilities and guarantees

Preserve the meanings in `CONTEXT.md`. `queued` follows RabbitMQ publisher confirmation, `saved` follows SQL commit, `rejected` is a recorded terminal processing result, and `applied` is a device acknowledgement. A late `queued` must not move a saved or rejected request backward. Never use an unqualified `delivered` result to combine those facts.

Keep `requestId`, `messageId`, and `eventId` distinct. The request ID survives client retries; the message ID identifies the durable message; an event ID deduplicates publication. Keep the SQL cursor `(chatId, sequence)` distinct from the Redis cursor `(room, epoch, streamId)`. Retrying an outbox publication retains its event ID even when Redis assigns a new Stream ID.

### RabbitMQ commands

Use a fixed partition set selected by chat ID for an existing chat or by the sorted sender and recipient IDs for a first direct send. Document the hash algorithm, input encoding, partition count, routing-key format, and topology ownership so every publisher agrees. Centralize Kotlin route definitions like the reference's `AssetMessaging` object and Go definitions like `messaging/topology.go`; verify agreement against the contract. A partition-count change needs an explicit routing transition.

Publish persistent JSON commands with mandatory routing and publisher confirms to durable quorum queues. Reject unroutable or negatively acknowledged publishes. A timeout leaves the outcome unknown; the caller retries with the same request ID and can query status. Return `queued` only after successful routing and confirmation.

Use manual consumer ACK after the SQL transaction commits. Bound consumer prefetch, worker concurrency, queue count, and backlog. Overflow rejects new publishes rather than discarding already-accepted commands. Queue partitioning distributes chats; SQL still owns the accepted order within a chat.

Separate permanent malformed input, durable business rejection, and transient dependency failure. Use bounded retries or an explicitly chosen delayed retry policy, with a terminal path for exhausted commands. A valid queued send must eventually have a durable saved/rejected result or remain recoverable work; silently discarding it into an unobserved dead queue breaks that promise. If recording a terminal result fails, retain retryable responsibility.

Keep queue failure policies visible in topology data, following `QueueFailurePolicy` / `QueueRoute` in the API. Verify broker-specific retry arguments against the pinned broker during setup and test them with real RabbitMQ. The file-upload project's worker failure codes and asset-cleanup queues do not transfer to Messenger.

### Redis room delivery and history

Use sharded Pub/Sub for immediate room delivery and bounded Streams for short replay. Every interested WS node subscribes independently to a room; each node shares that subscription among its local sockets. One shared consumer group would divide events among nodes and is not this broadcast contract.

Define key/channel naming and Redis Cluster hash tags centrally. A room's Stream, epoch metadata, and sharded live channel must use the intended shared slot for the publication operation. Logical room names include the room kind, such as `user:<id>` and `group:<id>`, so unrelated room kinds do not collide.

The publisher appends history and publishes the event with epoch/Stream position through a short Redis Function or Lua script. Prevalidate inputs; a runtime error after a Redis write does not roll it back. SQL and Redis do not share a transaction. Repeated publication is expected and retains stable event IDs.

Define history retention, epoch recreation, subscription acknowledgement, replay boundaries, deduplication, buffer limits, and the `recovery_failed` fallback. A Stream ID is not a gapless counter. Recovery must prove that the prior cursor is retained in the same epoch; otherwise use SQL catch-up. Never report device application merely because a subscriber existed or a socket write completed.

### WebSocket and HTTP recovery

Define each frame's discriminator/version, required fields, response or error, size limit, and authorization rule. Document reconnect behavior, heartbeat/timeout behavior, slow-client close/resync behavior, and device-applied acknowledgements. Use authenticated user/device context for room ownership and send commands.

History endpoints use bounded keyset pagination after a chat sequence. Request-status lookup must include or resolve the full deduplication scope, such as chat plus authenticated sender plus request ID, and enforce access. Its client-facing shape must distinguish an unknown/pending lookup from a recorded rejection.

Recovery must cover a Redis outage while sockets remain open, a quiet missed last event, membership revocation, and SQL fallback after trimmed/lost Stream history. SQL catch-up on reconnect and chat open remains required. A strict live freshness deadline needs database-backed reconciliation or a durable ledger beyond Redis position checks, as the existing architecture explains.

## Verification workflow

When implementing a contract change:

1. Edit its authoritative source from the generation table. Update operation semantics and examples alongside fields.
2. Validate AsyncAPI/schema references or export OpenAPI as appropriate. Generate every affected target and format it through the established scripts.
3. Run producer/consumer fixture tests and relevant Kotlin/Go tests. Inspect enums, numeric widths, requiredness, and null/omission behavior in generated output.
4. Regenerate in CI and fail on differences, including new untracked output. The reference uses intent-to-add before its generated-source diff check. Add equivalent checks for each generated artifact this project adopts.
5. Run real broker/database integration tests when topology, ACKs, retries, persistence, or recovery changes. Keep system-test helpers and fixtures separate from scenario files, following the reference's `tests/system` organization.

Retain a small cross-process system suite for a send through Go, RabbitMQ, Kotlin, SQL, Redis, and another WS node. Cover a second device for the sender, direct and group rooms, duplicate sends, saved-before-queued observation, rejection, worker crash before ACK, publisher crash after publication, Redis loss, and SQL catch-up. Use bounded waits and isolated test identities. Measure throughput and failure behavior separately from unit-test assertions; the standards do not establish a scaling target by themselves.

Source examples: `contracts/asyncapi.yaml`, `models.asyncapi.yaml`, `messages.yaml`, `channels/*`, `schemas/asset/*`, `generate-models.mjs`, `workers/internal/messagecodec/json_test.go`, `api/src/main/resources/application.yaml`, `.github/workflows/message-contracts.yaml`, `tests/system/*`.
