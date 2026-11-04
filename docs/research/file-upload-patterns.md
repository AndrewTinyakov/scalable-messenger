# Patterns to borrow from file-upload-system

This document records the comparison before implementation. The approved patterns have since been implemented. The user selected default uppercase HTTP/database enums instead of the lowercase JSON mapping proposed below. Refer to current source and tests for the implemented interfaces.

Compared on 2026-10-20 by three independent agents covering Kotlin, Go, and messaging/tests, followed by a source check in the main session. Sources are the current working files in both projects, including the earlier uncommitted refactors. No application code changed and no tests ran for this study. Every proposed example below is an unimplemented sketch.

Start with typed IDs and enum-preserving HTTP models. Both address concrete places where the messenger discards type information. Named repository mappings and model invariants are smaller follow-ups. Go construction and publication seams need more care because they affect lifecycle and testing. Contract generation offers the largest reduction in coordinated vocabulary edits but requires generator work.

## 1. Carry distinct ID types through a use case

**Reference.** [FileAssetService.kt](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/service/FileAssetService.kt:20) accepts distinct types:

```kotlin
fun getAsset(
    userId: UserId,
    assetId: FileAssetId,
): FileAssetResponse {
```

Its [repository](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/repository/FileAssetRepository.kt:34) retains the typed asset ID. Conversion to `.value` happens in SQL mapping.

**Messenger today.** [ChatService.kt](/Users/andrewtinyakov/code/pet/websockets/kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/ChatService.kt:89) and [ChatRepository.kt](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/repository/ChatRepository.kt:43) accept:

```kotlin
fun get(chatId: String, userId: String): ChatResponse
fun isMember(chatId: String, userId: String): Boolean
```

Swapping a user ID and chat ID compiles. Existing validation is not missing; the type signatures fail to communicate which validated value each argument represents. Messenger already has validated [UserId and ChatId](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/shared/id/Ids.kt:18), and [MessageController](/Users/andrewtinyakov/code/pet/websockets/kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/message/web/controller/MessageController.kt:29) already uses them.

**Proposed.**

```kotlin
fun get(chatId: ChatId, userId: UserId): ChatResponse
fun isMember(chatId: ChatId, userId: UserId): Boolean

chats.get(
    chatId = ChatId(requireId(id)),
    userId = UserId(session.userId),
)
```

Extend this through chat models, membership, repositories, and [room-address construction](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/redis/RoomAddress.kt:4). Unwrap at SQL and serialization seams. Preserve `requireId` at untrusted HTTP input so malformed IDs retain `INVALID_ID` rather than becoming a generic `INVALID_REQUEST` through constructor exceptions.

**Decision: adopt incrementally.** Start with chat and membership. Auth can follow with typed user IDs and distinct session/token types where they prevent confusion. Session IDs are 64-character hashes, cookie tokens are different opaque strings, and device IDs are not ULIDs; do not force them through `ChatId`-style validation. Named arguments remain useful when actor and member are both `UserId`. The reference Go workers still use raw string IDs, so a Go ID migration would be a further design choice, not a pattern already demonstrated there.

## 2. Keep enums in HTTP responses and generated clients

**Reference.** [FileAssetPayloads.kt](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/web/payload/FileAssetPayloads.kt:20) keeps its finite vocabularies:

```kotlin
val handlingMode: HandlingMode,
val status: AssetStatus,
```

**Messenger today.** [ChatPayloads.kt](/Users/andrewtinyakov/code/pet/websockets/kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/web/payload/ChatPayloads.kt:15) erases an existing enum:

```kotlin
val kind: String,
```

The mapper uses `kind = kind.value`. The [generated client](/Users/andrewtinyakov/code/pet/websockets/client/src/shared/api/generated/schema.d.ts:261) consequently receives `kind: string`; [the client chat model](/Users/andrewtinyakov/code/pet/websockets/client/src/entities/chat/model.ts:4) restores a handwritten `ChatKind` imported from the socket vocabulary. This is an actual duplication of type information, not evidence of an observed typo bug.

**Proposed.** Reuse [ChatKind](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/model/ChatKind.kt:3), preserving lowercase wire values:

```kotlin
enum class ChatKind(@get:JsonValue val value: String) {
    DIRECT("direct"),
    GROUP("group"),
}
```

```kotlin
val kind: ChatKind,
```

Regenerate OpenAPI and TypeScript. The desired generated field is `kind: "direct" | "group"`; verify the schema and JSON rather than assuming the annotation alone guarantees both.

The same opportunity exists in [SendStatusResponse](/Users/andrewtinyakov/code/pet/websockets/kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/message/web/payload/MessagePayloads.kt:34):

```kotlin
val status: String,
val reason: String? = null,
```

Use an HTTP lookup-status enum containing `UNKNOWN`, `SAVED`, and `REJECTED`, mapped exhaustively from persisted status. Do not add `UNKNOWN` to the persisted `SendResultStatus`: unknown means the lookup found no saved result. Reuse the already-generated `SendRejectionReason` for `reason`, preserving its existing wire values.

**Decision: adopt early.** It reduces parallel Kotlin/client edits. Serialization and generated-schema fixtures are required when implemented. TypeScript types still do not validate network bytes; retain runtime decoding.

## 3. Generate fixed event discriminators from the contracts

**Reference inspiration.** [VariantSpec](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/image/profiles.go:21) uses a generated schema vocabulary:

```go
type VariantSpec struct {
    Type     messaging.AssetVariantType
    MaxWidth int
    Encoding Encoding
}
```

The reference does not already solve fixed event discriminators. This proposal extends the same schema-owned vocabulary idea to a concrete messenger gap.

**Messenger today.** The [event schema](/Users/andrewtinyakov/code/pet/websockets/contracts/schemas/message/event/message-saved-v1.yaml:8) fixes `type` to `message_saved`, but the [generated Kotlin constructor](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/generated/asyncapi/kotlin/com/andrewtinyakov/messenger/generated/messaging/event/MessageSavedEventV1.kt:4) accepts:

```kotlin
val type: String,
```

The [producer](/Users/andrewtinyakov/code/pet/websockets/kotlin/command-processor/src/main/kotlin/com/andrewtinyakov/messenger/message/service/MessageSendService.kt:123) supplies:

```kotlin
type = RoomEventType.MESSAGE_SAVED.value,
```

There is already a centralized Kotlin enum, so scattered producer literals are not the problem. The schema, handwritten [RoomEventType](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/outbox/RoomEventType.kt:3), and Go [EventType](/Users/andrewtinyakov/code/pet/websockets/ws/internal/protocol/protocol.go:29) maintain the same spellings independently. A constructor also permits pairing a message-saved body with another event's type.

**Proposed constructor shape.**

```kotlin
MessageSavedEventV1(
    version = 1,
    eventId = eventId,
    room = room,
    chatId = chatId.value,
    requestId = requestId.value,
    messageId = messageId.value,
    sequence = sequence.toString(),
    senderId = senderId.value,
    body = body,
    createdAt = now,
)
```

The generated model would serialize its schema's fixed discriminator. A defaulted `String` parameter alone is weaker because callers could still override it. Generate symbols or a singleton discriminator type and keep decoding strict enough to reject a mismatched incoming type. Update the contract or [generator](/Users/andrewtinyakov/code/pet/websockets/contracts/generate-models.mjs:30), never generated files directly.

**Decision: useful second phase.** This targets coordinated edits directly, but costs generator maintenance and cross-language wire tests. Preserve the distinction between room events and socket-only events. The current model-generation entry point covers broker models; expanding socket generation is additional work.

## 4. Give Go error codes and metric outcomes one vocabulary

**Reference.** [runner.go](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/worker/runner.go:36) declares outcomes and [metrics.go](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/monitoring/metrics.go:70) hides label rendering behind a method:

```go
type ProcessingOutcome string

const ProcessingSucceeded ProcessingOutcome = "succeeded"
```

```go
func (metrics *WorkerMetrics) ObserveProcessing(duration time.Duration, outcome worker.ProcessingOutcome)
```

Stable failure spellings are also centralized in [errors.go](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/worker/errors.go:8).

**Messenger today.** [Connection.error](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/connection.go:297) and [send metrics](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/commands.go:43) use plain strings:

```go
func (c *Connection) error(code, requestID string)
```

```go
c.server.metrics.PublishSeconds.WithLabelValues("failed").Observe(time.Since(started).Seconds())
```

The code spelling is repeated in branches; [metrics vectors](/Users/andrewtinyakov/code/pet/websockets/ws/internal/monitoring/metrics.go:5) are public. A typo can change a client code or create a separate metric series.

**Proposed.**

```go
type ErrorCode string

const ErrorInvalidFrame ErrorCode = "invalid_frame"
```

```go
func (c *Connection) error(code protocol.ErrorCode, requestID string)

c.error(protocol.ErrorInvalidFrame, frame.RequestID)
c.server.metrics.ObservePublish(time.Since(started), monitoring.PublishFailed)
```

Keep existing wire strings and metric label values. `ErrorCode` belongs at the protocol seam; incremental metric outcome types can live beside monitoring while that package owns its concrete adapter. Do not introduce an import cycle by making monitoring import socket while socket still imports monitoring.

Go's named string types are not closed enums. Constants make misspelled constant names fail compilation and prevent ordinary string variables being passed implicitly, but an arbitrary untyped string literal still compiles. A finite generated vocabulary plus validation is stronger. [error-v1.yaml](/Users/andrewtinyakov/code/pet/websockets/contracts/schemas/socket/frame/error-v1.yaml:12) currently permits any nonempty code; putting an enum there and wiring socket generation would be a deliberate contract change.

**Decision: adopt the small vocabulary cleanup.** Consider schema-owned error codes with the generator work in item 3. Do not invent wrappers for every human-readable log message. Existing `FrameType`, `EventType`, `ChatKind`, and generated rejection-reason validation are strengths to retain.

## 5. Enforce stable model invariants at construction

**Reference.** [FileAsset.kt](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/model/FileAsset.kt:32) ties failure state to its fields:

```kotlin
if (status == AssetStatus.FAILED || status == AssetStatus.DISCARDED) {
    require(!failureCode.isNullOrBlank())
} else {
    require(failureCode == null)
}
```

**Messenger today.** [SendResult](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/message/model/SendResult.kt:9) has independent nullable fields:

```kotlin
val status: SendResultStatus,
val messageId: MessageId?,
val sequence: Long?,
val reason: SendRejectionReason?,
```

SQL already enforces the [persisted shape](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/resources/db/migration/V1__messenger.sql:49), and inspected factories construct valid results. The gap is that a new constructor or `copy` can create an invalid in-memory result before SQL rejects it.

**Proposed class body.**

```kotlin
init {
    require(chatId != null || recipientId != null)
    when (status) {
        SendResultStatus.SAVED ->
            require(messageId != null && sequence != null && reason == null)
        SendResultStatus.REJECTED ->
            require(messageId == null && sequence == null && reason != null)
    }
}
```

**Decision: adopt small checks.** Keep the SQL constraints. The result target uses OR, not exclusive-or: a saved direct send can have both its resolved chat and recipient. Membership, uniqueness, and mutable database facts do not belong in constructors. A sealed saved/rejected hierarchy could encode more at compile time, but is a larger redesign than this reference pattern requires.

## 6. Name database fields instead of depending on projection positions

**Reference.** [JooqFileAssetRepository.kt](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/main/kotlin/com/andrewtinyakov/fileupload/asset/repository/JooqFileAssetRepository.kt:170) names its mapping:

```kotlin
private fun FileAssetsRecord.toModel() = FileAsset(
    id = FileAssetId(id!!),
    ownerId = UserId(ownerId!!),
    filename = originalFilename!!,
```

**Messenger today.** [JooqChatRepository.kt](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/repository/JooqChatRepository.kt:39) uses projection ordinals:

```kotlin
id = row.value1()!!,
kind = ChatKind.valueOf(row.value2()!!.uppercase()),
name = row.value3(),
lastSequence = row.value4()!! - 1,
```

`MemberChat` also takes `value5()` and `value6()` positionally. Reviewers must look back at the SELECT; reordering same-typed projected columns can still compile. [findById](/Users/andrewtinyakov/code/pet/websockets/kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/repository/JooqChatRepository.kt:140) separately repeats chat conversion.

**Proposed joined-row excerpt.**

```kotlin
id = row.get(CHATS.ID)!!,
kind = ChatKind.valueOf(row.get(CHATS.KIND)!!.uppercase()),
name = row.get(CHATS.NAME),
lastSequence = row.get(CHATS.NEXT_SEQUENCE)!! - 1,
```

Name the outer `chat`, `joinedAt`, and `memberCount` arguments too. Whole-record queries can use a private `ChatsRecord.toModel()`.

**Decision: adopt locally.** Keep existing projections and SQL. A general `Record` extension has a hidden required-field set; prefer generated record types for whole rows and explicit access for joined projections unless a shared mapper earns its complexity. Existing message mappings already use named fields in several places.

## 7. Accept consuming-package interfaces through production constructors

**Reference.** [image/processor.go](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/image/processor.go:25) owns the storage operations it needs; its constructor accepts that interface:

```go
func NewProcessor(client Client, variantConcurrency int) Processor
```

The command package creates the concrete adapter. [Runner](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/worker/runner.go:53) similarly stores `Consumer` and `Handler` interfaces.

**Messenger today.** [Server](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/server.go:60) already stores consuming-package interfaces, but [NewServer](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/server.go:92) accepts concrete gRPC, RabbitMQ, and Redis clients and creates rooms itself. Tests such as [session_test.go](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/session_test.go:108) build `&Server{...}` directly to supply fakes.

Production and tests therefore use different initialization paths even though the useful interfaces already exist.

**Proposed dependency group.** Existing capability interfaces are composed into `authorizer` and `admissionStore` here:

```go
type Dependencies struct {
    Authorization authorizer
    Publisher     commandPublisher
    Admission     admissionStore
    Rooms         roomCoordinator
}
```

`NewServer` would accept this group, validate required dependencies, and perform the existing initialization. `cmd/ws-server` would construct the concrete adapters and rooms. Operational tests could use the same constructor with fakes.

**Decision: adopt when refactoring socket construction.** Medium scope because room ownership, startup, batching capabilities, cancellation, and joined shutdown must stay intact. Keep the existing reader/writer and command-queue design. This is not a reason to copy the reference worker scheduler.

A related Kotlin adaptation is an outbox-owned publication seam. [OutboxPublicationService](/Users/andrewtinyakov/code/pet/websockets/kotlin/outbox-publisher/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/outbox/OutboxPublicationService.kt:19) currently takes concrete `RoomEventPublisher`:

```kotlin
fun interface OutboxEventPublisher {
    fun publish(message: OutboxMessage)
}
```

That would let per-room scheduling and failure-policy tests run without Redis while retaining real Redis tests for atomic publication, deadlines, and cancellation. Successful return must still mean the existing Redis script completed, not merely that work was queued. Current CI already supplies Redis; this addresses local policy testing and clearer failure injection. The reference Kotlin outbox takes `RabbitTemplate` directly, so this is an adaptation of its Go pattern, not a claim that its Kotlin outbox is better separated.

## 8. Test the existing consumer ACK/reject contract directly

**Reference.** [MessageConsumptionTests.kt](/Users/andrewtinyakov/code/pet/file-upload-system/api/src/test/kotlin/com/andrewtinyakov/fileupload/infrastructure/messaging/MessageConsumptionTests.kt:28) tests success ordering, permanent/transient failures, fatal errors, and channel failures:

```kotlin
consumeMessage(message, channel, logger) {
    Mockito.verifyNoInteractions(channel)
    processed = true
}
Mockito.verify(channel).basicAck(tag, false)
```

**Messenger today.** The [consumeMessage helper](/Users/andrewtinyakov/code/pet/websockets/kotlin/command-processor/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/messaging/MessageConsumption.kt:20) already follows the same disposition policy. Tests call the processing service directly and disable listeners; no focused Kotlin test currently calls this helper. The production code is not shown to be wrong. The gap is regression coverage for ACK ordering and failure propagation.

**Proposed test excerpt.**

```kotlin
consumeMessage(message, channel, logger, SimpleMeterRegistry(), "send") {
    Mockito.verifyNoInteractions(channel)
    processed = true
}
assertTrue(processed)
Mockito.verify(channel).basicAck(tag, false)
Mockito.verifyNoMoreInteractions(channel)
```

**Decision: adopt.** Port the reference's failure cases as well. The helper's successful action returns after `TransactionTemplate.execute` commits in the processing service. These tests protect the helper contract; retain actual SQL and broker resilience tests to prove commit, replay, and failover behavior. No new production abstraction is needed for this candidate.

## What to retain

- Explicit transactions, generated broker contracts, SQL constraints, real PostgreSQL tests, bounded socket queues, and joined goroutines are already present.
- Messenger's JSON decoder rejects more malformed input than the shorter reference decoder. Do not replace it to reduce code size.
- `SendRejectionReason` is already generated and used across Kotlin persistence and Go validation. Reuse it rather than introduce parallel enums.
- The reference itself returns HTTP DTOs from services. A rule moving every response conversion to controllers would be an independent architectural preference.
- Keep messenger's claim/publish/complete outbox lifecycle. The reference Kotlin outbox waits for RabbitMQ while inside a database transaction; copying that would change this project's guarantees.
- SQL chat sequences and Redis stream cursors represent different positions. Any later wrapper types must preserve that separation and decimal-string wire encoding.

## Smaller Go follow-ups

[The reference preserves error causes](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/worker/errors.go:16) through `Unwrap`. Messenger's [publish-failure branch](/Users/andrewtinyakov/code/pet/websockets/ws/internal/socket/commands.go:42) emits a metric and wire code, then returns nil, losing the original cause in this path. A small typed failure returned to the existing connection error handler could centralize translation and retain the cause for logging. Preserve `publish_unknown` versus `publish_failed` and keep queued acknowledgments after confirmation.

[The reference monitoring server](/Users/andrewtinyakov/code/pet/file-upload-system/workers/internal/monitoring/server.go:23) calls `net.Listen` synchronously. Messenger [starts ListenAndServe in a goroutine and immediately logs listening](/Users/andrewtinyakov/code/pet/websockets/ws/cmd/ws-server/app.go:60). Binding before that log would prevent a misleading success message when a port is occupied. This is a small diagnostic improvement, not a missing startup-error path.
