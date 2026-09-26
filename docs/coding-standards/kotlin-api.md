# Kotlin API coding standards

Use these rules for the Messenger Spring Boot API, command consumers, and SQL outbox relay. Read [contracts.md](contracts.md) when changing HTTP, WebSocket, RabbitMQ, or Redis payloads. The Go application follows [go-websocket.md](go-websocket.md).

## Origin and scope

These standards derive from the actual code in `/Users/andrewtinyakov/code/pet/file-upload-system`, inspected on 2026-09-26. Its HEAD was `7f7aa0d1892b7bc332154a95c480af2964093b62`; the checkout had local changes, so the reference is the files on disk at inspection time. Source paths below are relative to that repository. `K` means `api/src/main/kotlin/com/andrewtinyakov/fileupload`; `T` means the corresponding `api/src/test/kotlin/com/andrewtinyakov/fileupload` directory.

Rules about naming, feature packages, interfaces, jOOQ, payloads, explicit mapping, and tests preserve the API's conventions. Sections marked Messenger adaptation apply those conventions to this project's [architecture](../../research/messenger-architecture.md), [detailed flow](../../research/messenger-detailed-flow.md), and [broker decision](../adr/0001-messenger-broker-split.md). Example Messenger filenames describe the intended layout; application code does not exist yet.

## Stack

Keep the reference API's stack. These are versions observed in its build files, not a claim about the latest releases.

| Concern | Reference baseline |
| --- | --- |
| Language and runtime | Kotlin 2.3.21, JVM toolchain 25 |
| Application | Spring Boot 4.1.1, Spring MVC, Spring Security, Jakarta Validation |
| Database | PostgreSQL, Spring jOOQ starter, jOOQ code generation 3.21.7, Flyway SQL migrations |
| JSON | Jackson 3, `tools.jackson` databind and Kotlin module |
| Messaging | Spring AMQP, RabbitMQ quorum queues |
| HTTP documentation | springdoc WebMVC API 3.1.1, OpenAPI Gradle plugin 1.9.0 |
| IDs and time | `ulid-creator` 5.2.4 behind `UlidGenerator`, injected `java.time.Clock` |
| Monitoring | Actuator, Micrometer, Prometheus; SLF4J logging |
| Build and formatting | Gradle Kotlin DSL and checked-in wrapper, ktlint plugin 14.2.0 with ktlint 1.8.0 |
| Tests | JUnit 5, `kotlin.test`, Mockito, Spring Boot tests, Testcontainers, Awaitility |

Use blocking MVC and jOOQ, with the reference's virtual-thread configuration. Keep database access in jOOQ repositories; a JPA/Hibernate or reactive rewrite is an architecture change. Adopt PostgreSQL as the initial same-stack baseline. The MySQL/Vitess and other storage research remains an alternative requiring an explicit decision before implementation changes the transaction model.

Redis sharded Pub/Sub and Streams are Messenger additions. Select and pin the Redis client during setup. The file-upload project provides no Redis-client precedent. Carry over relevant dependencies; S3, MinIO, and image-processing libraries belong to file-upload features and are not Messenger requirements.

Source: `api/build.gradle.kts`, `api/src/main/resources/application.yaml`, `.editorconfig`, `compose.local.yaml`.

## Feature first, technical role second

Put a capability at the first package level, then divide its implementation by role. Use `com.andrewtinyakov.messenger` as the application package. A feature grows only the directories it needs.

```text
api/src/main/kotlin/com/andrewtinyakov/messenger/
  ApiApplication.kt
  conversation/
    model/Conversation.kt, ConversationId.kt, Membership.kt
    repository/ConversationRepository.kt, JooqConversationRepository.kt
    service/ConversationService.kt, MembershipService.kt
    web/controller/ConversationController.kt
    web/payload/ConversationPayloads.kt
    config/ConversationProperties.kt
  message/
    model/Message.kt, MessageId.kt, SendRequest.kt
    dto/SavedMessageDto.kt
    repository/MessageRepository.kt, JooqMessageRepository.kt
    service/MessageService.kt, SendRequestService.kt
    web/controller/MessageController.kt, SendRequestController.kt
    web/payload/MessagePayloads.kt, SendRequestPayloads.kt
    messaging/listener/SendMessageListener.kt
    messaging/publisher/MessageSavedPublisher.kt
    monitoring/MessageMetrics.kt
    scheduling/SendRequestRetentionScheduler.kt
  user/UserId.kt
  infrastructure/
    config/
    messaging/
    outbox/
    redis/
  shared/
    id/
    crypto/
    integration/
    web/
```

- Keep a feature's services, repositories, models, HTTP payloads, and message handlers together. Global `controllers/`, `services/`, and `repositories/` trees lose that ownership.
- Use singular package names matching the source: `model`, `repository`, `service`, `dto`, `web.controller`, `web.payload`, `messaging.listener`, `messaging.publisher`, `config`, `scheduling`, `monitoring`.
- Use `infrastructure` for application wiring and mechanisms shared across features, such as messaging topology and outbox persistence. Use `shared` for small reusable types and functions, such as IDs, hashing, and HTTP errors. Keep business decisions in their feature.
- External integrations live under the owning feature's `integration` package. Put provider implementations below it, as `integration/ObjectStorage.kt` and `integration/s3/S3ObjectStorage.kt` do in the reference. Provider-neutral results belong in `integration/dto`.
- A small capability can begin with one file, like the reference's `user/UserId.kt`. Create deeper directories when there is code to organize.
- A service can call another focused service. Keep dependencies acyclic and inject the service directly. The reference's `UploadSessionActionsService` calls `FileAssetService`; it does not introduce a dispatcher or command bus for that call.

## Interfaces and concrete classes

The reference has five handwritten production interfaces: `FileAssetRepository`, `UploadSessionRepository`, `AssetVariantRepository`, `OutboxRepository`, and `ObjectStorage`. This is the default abstraction policy here.

| Role | Rule | Reference example |
| --- | --- | --- |
| Persistence | Interface named for the model or capability; implementation prefixed `Jooq`; colocate the pair | `FileAssetRepository` / `JooqFileAssetRepository` |
| External capability | Interface named for the operation the application needs; implementation named for its provider | `ObjectStorage` / `S3ObjectStorage` |
| Service | Concrete `@Service`; inject it directly | `UploadSessionService`, `AssetPreparationService` |
| Controller | Concrete `@RestController` | `UploadSessionController` |
| Publisher and listener | Concrete `@Component`; delegate transport mechanics | `AssetPreparationPublisher`, `AssetPreparationResultListener` |
| Scheduler | Concrete `@Component`; delegate work to a service | `AssetCleanupScheduler` |
| Metrics | Concrete recorder with a `MeterRegistry` dependency | `UploadSessionMetrics` |
| Configuration | Concrete properties type and `@Configuration` bean factory | `UploadProperties`, `S3Config` |
| Small helper | Top-level function, or concrete component when injected | `sha256Hex`, `UlidGenerator` |
| Mapping | Explicit extension or private function | `FileAssetsRecord.toModel`, `FileAsset.toResponse` |

Use repository and external-capability interfaces even when there is one production implementation. They isolate persistence or provider behavior and give tests a useful boundary. Do not generate `IMessageService`, `MessageServiceImpl`, controller interfaces, mapper interfaces, or generic base repositories by default. A new interface needs an actual capability boundary, not a matching interface for every class.

Feature repository pairs live in `feature/repository`. A self-contained infrastructure capability keeps its pair beside its other types, as `OutboxRepository` and `JooqOutboxRepository` live in `infrastructure/outbox` in the source.

Inject dependencies through the primary constructor as `private val`. Annotate implementations, not repository interfaces. Use `@Repository` for jOOQ adapters and `@Configuration(proxyBeanMethods = false)` for configuration. Keep dependencies required; optional constructor arguments should represent real optional behavior.

## File, type, and function names

| Item | Convention | Messenger example |
| --- | --- | --- |
| Main type | `PascalCase.kt`, matching the type | `SendRequestService.kt` |
| Model | Domain noun without `Entity` or `Dto` suffix | `Message.kt` |
| Typed identity | `<Thing>Id.kt`, `@JvmInline value class` | `ConversationId.kt` |
| Enum | Domain name in its own file | `SendRequestStatus.kt` |
| Internal transfer object | Specific name; `Dto` suffix where it clarifies the role | `SavedMessageDto.kt` |
| HTTP payload family | `<Resource>Payloads.kt` | `MessagePayloads.kt` |
| Request / response | Action plus resource plus `Request`; resource plus `Response` | `CreateConversationRequest`, `MessageResponse` |
| Config values | `<Capability>Properties` | `MessageProperties` |
| Config wiring | `<Capability>Config` | `RedisConfig` |
| Message model | Imperative `...CommandV1`; past-tense `...EventV1` | `SendMessageCommandV1`, `MessageSavedEventV1` |
| Unit / integration tests | `<Subject>Tests.kt`, mirroring its production package | `SendRequestServiceTests.kt` |
| SQL migration | `V<number>__<snake_case_description>.sql` | `V1__create_initial_schema.sql` |
| Pure function file | Name the capability | `Hashing.kt`, `MessageConsumption.kt` |

One principal class, interface, enum, or value class per file is the normal shape. Closely related HTTP payloads and their conversion functions share a `Payloads.kt` file. A small properties type may share its configuration file, as `MessagingProperties` shares `RabbitConfig.kt`. Related top-level helpers may live beside the type they support. Avoid general `Utils.kt`, `Common.kt`, or a single file collecting every model.

`Properties` is the normal configuration-value suffix, although the reference calls one such type `OutboxConfig`. Keep this exception visible when copying that component; the naming rule does not mean every source `Config` is a bean factory.

Use lower camel case for functions and properties, upper snake case for constants and enum entries. Name functions by their observable effect:

| Name pattern | Meaning in the reference | Apply here |
| --- | --- | --- |
| `findBy...` | Lookup that can miss | `findById(...): Message?`; collection lookup returns an empty list |
| `get...` | Retrieve a value or service response; service handles absence and access | `getHistory(...)`, `getRequestStatus(...)` |
| `require...` | Obtain or check a required value and fail if unavailable | Private `requireConversation(...)` |
| `validate...` | Check supplied values; no persistence | `validateMessageSize(...)` |
| `...ForUpdate` | Query obtains row locks inside a transaction | `findByIdForUpdate(...)` |
| `insert`, `complete`, `expire`, `transitionStatus` | Specific persistence operation | `insert(message)`, `transitionStatus(expected, next)` |
| `enqueue...` | Add durable work to the current SQL transaction | `enqueueSaved(...)` |
| `publish...` | Perform broker publication or drain pending work | `publishPending()` |
| `on...Command`, `on...Event` | Incoming message entry point | `onSendCommand(...)` |
| `run...` | Scheduled entry point | `runRetention()` |
| `...Batch` | Bounded private batch operation | `publishBatch()` |
| `toModel`, `toModels`, `toResponse` | Explicit type conversion | `MessagesRecord.toModel()` |
| Past-tense metric method | Record a completed application fact | `messageSaved(...)`, `requestRejected(...)` |

These are naming defaults, not a rule to rename every method to include its class name. `create`, `abort`, and `complete` are clear on a narrowly named service. `get` does not universally mean a DB lookup that throws; `getPublicUrl` is a value-building integration method in the reference.

## Small files and readable Kotlin

Keep each file focused on one responsibility. The source splits creation, session actions, preparation, cleanup, and expiration into separate services. Follow that approach for history reads, send processing, membership changes, and retention instead of accumulating everything in `MessengerService`.

Use about 250 lines as a review signal for handwritten production files. Around 350 lines, look for a responsibility to extract before adding more. These are new review guidelines, not existing automated limits: the reference has a 341-line service and a 1,388-line API test. Split tests by behavior as they grow. Generated sources are exempt. Do not split coherent code into arbitrary numbered files to meet a count.

- Use immutable `data class` values, `val`, typed enums, and `copy` for changed snapshots. Keep mutable bookkeeping local and explicit.
- Use named arguments for domain calls with several values, especially several IDs, strings, or timestamps. Use trailing commas in multiline calls and declarations.
- Use expression bodies for short delegation and mapping. Use blocks, early returns, and named private functions for multi-step decisions. `when` handles enum branches.
- Put public use-case methods before their private helpers. Name helpers for a step such as `createSession`, `persistUpload`, or `replaySession`; keep the main method readable as the operation's sequence. Use a small function parameter for a local variation, as `FileAsset.toResponse` accepts `variantUrl`, instead of adding a class hierarchy.
- Use `private` for implementation helpers and `internal` for module-only DTOs and infrastructure helpers. Export only types and functions that callers need.
- Keep nullable values meaningful. Use `?: notFound()` at the service boundary, `requireNotNull` for established invariants, and null-safe mapping for genuinely optional values.
- Use `require` for invalid arguments or domain invariants and `check` for impossible internal state or unexpected database write counts. Translate failures from untrusted input to the appropriate public error at the boundary.
- Use import aliases for colliding domain and generated names, as `DatabaseUploadStrategy` and `StorageCompletedPart` do in the reference.
- Keep formatting aligned with the reference `.editorconfig`: four-space Kotlin indentation, official ktlint style, trailing commas, and its multiline/chain overrides. Copy the formatter configuration when scaffolding the API rather than recreating its wrapping rules by hand.

The source explicitly disables ktlint's `multiline-expression-wrapping`, `function-expression-body`, `function-signature`, and `chain-method-continuation` rules. Preserve those overrides with the matching IDE wrapping settings. Keep the strict compiler settings `-Xjsr305=strict` and `-Xannotation-default-target=param-property`; use explicit `@field:` targets for payload validation and schema annotations as the source does.

## Models, DTOs, payloads, and mapping

Keep the representations distinct:

| Representation | Location and responsibility |
| --- | --- |
| Domain model | `feature/model`; typed IDs, domain enums, immutable state and invariants |
| Internal DTO | `feature/dto`; a result or values exchanged between application operations |
| Integration DTO | `feature/integration/dto`; application-facing provider request/result without SDK types |
| HTTP payload | `feature/web/payload`; public JSON request or response shape |
| Message contract | Generated `feature/messaging/command` or `event`; versioned wire shape |
| jOOQ record and database enum | Generated database package; used by repository implementations |

Use `@JvmInline value class MessageId(val value: String)` and corresponding identity types internally. Convert to strings at wire and database boundaries. Keep model enum types separate from generated database enums. Explicit `valueOf(name)` mapping follows the reference when the names intentionally match; use `when` when they differ.

Map by constructing the target with named fields. Place a private `Record.toModel()` at the bottom of the jOOQ repository. Put public response conversions alongside the HTTP payloads. Small message-to-model conversions can live beside the model, as `AssetVariantV1.toModel()` does in the reference. Keep them deterministic; the service provides values that require I/O. No mapping framework or mapper service interface is needed.

HTTP-facing services may accept request payloads and return response payloads. This matches `UploadSessionService` and `FileAssetService`; a mandatory extra DTO for every HTTP call would change the reference style. Repository signatures still return domain models, and SDK/jOOQ types stay out of controllers and public payloads. For an operation shared by HTTP and queue consumers, expose an application result so the queue path does not need an HTTP response.

Messenger adaptation: `UploadSession.kt` in the source includes a response helper that calls storage. Here, perform authorization and remote calls in the service or integration adapter and pass their results to mapping functions. Preserve the explicit conversion style without growing I/O inside Messenger models.

## Controllers, validation, and errors

Keep controllers thin. Bind and validate input, obtain the authenticated identity, wrap IDs, delegate to a concrete service, and set HTTP status or headers. Keep SQL, broker calls, transaction coordination, and business transitions in their owning components.

Follow the `/api` servlet prefix and `/v1/<plural-kebab-case-resource>` controller paths. Use `@RestController`, `@RequestMapping`, and verb-specific mappings. Use `ResponseEntity` when returning a `Location` header or variable status; use direct typed responses and `@ResponseStatus` for fixed responses. A `202` response must describe the accepted asynchronous state and expose a way to retrieve its result.

Use `@Valid @RequestBody` and `@field:` Bean Validation annotations for structural input constraints. Service validation covers membership, legal state transitions, idempotency, and configuration-dependent limits. Model `init` checks protect constructed domain values. SQL constraints protect persisted invariants. A generated type or a value-class constructor alone does not validate an external string.

Keep `ApiException`, `ApiErrorCode`, and `ApiExceptionHandler` in `shared/web`. Return Spring `ProblemDetail` with a stable `code`. Use focused helpers such as `badRequest`, `conflict`, and `notFound`, returning `Nothing`. Translate provider failures to `DependencyUnavailableException` at the integration boundary; log the cause internally and return a generic 503. Unexpected failures return a generic 500. Keep framework binding/validation failures as client errors and test this explicitly.

Messenger adaptation: the source uses a validated `X-User-ID` header and permits application requests without authentication. This is a demo convention, not the Messenger identity boundary. Obtain user/device identity from verified credentials; enforce membership in history, status, room authorization, and send processing. A request body or arbitrary header cannot choose the acting user. The reference's owner-filtered `?: notFound()` pattern is useful when hiding another user's resource existence.

## Repositories and jOOQ

Repository interfaces describe needed operations, with domain values as parameters and results. Use specific operations instead of a universal CRUD interface or a `save` that hides whether it inserts or changes state.

- Inject `DSLContext` as `db` into the concrete `Jooq...Repository`.
- Import generated table constants and use the typed DSL: `selectFrom`, `insertInto`, `update`, explicit predicates, ordering, and limits. Keep handwritten SQL out of services and controllers.
- Bind IDs using `.value`. Map records to domain values before returning. Generated Java records can use `!!` for columns guaranteed `NOT NULL` by migrations; optional columns remain nullable. This exception belongs in record mapping, not general application input handling.
- Return `null` from a missing single-row lookup. Use `fetchOne()?.toModel()` for optional rows and `fetchSingle()` only when existence is guaranteed by the operation.
- Include the expected previous status in transition predicates. Check affected row counts with `check`, including batch writes. An unexpected count must not silently become success.
- Name locking reads explicitly. Call `...ForUpdate` only inside the service's transaction. Background candidate selection uses bounded, ordered queries with `FOR UPDATE SKIP LOCKED`.
- Accept collections for batch writes and return early for an empty collection. Use one multi-row insert when the operation supports it, following the outbox repository.
- Design schema constraints alongside service invariants: named foreign keys, unique idempotency keys, checks, and indexes for actual lookups and background scans. SQL uses plural snake-case tables and snake-case columns; the reference uses descriptive `_unique`, `_fk`, `_idx`, and validity constraint names.

For example, this is the reference's repository shape adapted to conversation-scoped message access. Imports and the remaining model fields are omitted:

```kotlin
interface MessageRepository {
    fun findById(
        conversationId: ConversationId,
        id: MessageId,
    ): Message?
}

@Repository
class JooqMessageRepository(
    private val db: DSLContext,
) : MessageRepository {
    override fun findById(
        conversationId: ConversationId,
        id: MessageId,
    ): Message? =
        db
            .selectFrom(MESSAGES)
            .where(
                MESSAGES.CONVERSATION_ID.eq(conversationId.value),
                MESSAGES.ID.eq(id.value),
            ).fetchOne()
            ?.toModel()
}

private fun MessagesRecord.toModel() =
    Message(
        id = MessageId(id!!),
        conversationId = ConversationId(conversationId!!),
        sequence = sequence!!,
    )
```

Flyway migrations are the schema source. Apply migrations to the generation database, then run `jooqCodegen`. Commit generated tables, records, and enums under `api/src/generated/java`. Keep DAO and POJO generation disabled as in the reference. Never edit generated Java to repair schema drift. Add a new migration once an earlier migration has been applied to a shared environment.

## Transactions and background work

Use an injected `TransactionTemplate` and visible `tx.execute` / `tx.executeWithoutResult` blocks at the service boundary. This is the source's transaction pattern. Repository methods participate in that transaction; they do not independently commit parts of a use case.

Preserve the reference's idempotency behavior: persist a scoped key and request fingerprint, return the established result for a matching retry, and reject reuse with a different payload. A preflight lookup is insufficient for concurrent requests; enforce uniqueness in SQL and handle the race by reading the committed result. Do not count a replay as a new successful transition.

Keep listeners and schedulers as adapters. `on...` decodes and dispatches; a service executes the operation; consumption infrastructure decides ACK/retry. A scheduler delegates to a service using fixed-delay configuration. Bound batch size and batches per run. Allow scheduling and queue listeners to be disabled for tests, contract export, and separate process roles.

Messenger adaptation:

1. The command service commits membership validation, request deduplication, conversation sequence allocation, message insertion, final request result, and outbox rows in one SQL transaction. A business rejection commits its result and sender notification without a message.
2. The listener ACKs only after that transaction succeeds. A database failure leaves the command retryable. Duplicates return the recorded result. Follow [contracts.md](contracts.md) for terminal failure and retry rules.
3. The relay claims a bounded batch with an expiring lease in a short transaction, releases row locks, publishes through Redis, then marks completion only while it still owns the lease. Reclaim expired leases and retain stable event IDs across retries.
4. Keep broker/network waits outside the message transaction. The reference's `OutboxService.publishBatch` holds a SQL transaction while waiting for Rabbit confirms; Messenger uses the lease flow already specified in its detailed design.
5. Record success metrics after commit. If a transaction can join an outer transaction, use an after-commit hook or keep ownership at the outer service boundary; returning from a nested template is not proof of final commit.

The API HTTP role, Rabbit consumer role, and relay may share an image and feature code. Give each an independent lifecycle and enablement configuration. Background work must not depend on an active WebSocket connection.

## Configuration, monitoring, and operational code

Use typed `@ConfigurationProperties`, scanned by the application, with `Duration`, `URI`, numeric limits, and `init` validation. Use kebab-case YAML keys under `messenger.*`. Put feature limits in that feature's configuration; shared transport settings belong in infrastructure. Inject SDK clients, `Clock`, and `UlidGenerator`. Read the clock once when an operation needs one consistent timestamp.

Keep YAML environment overrides and local development configuration separate. Use the reference's strict Jackson behavior: reject unknown fields, scalar coercion, fractional integers, and null primitive values; omit absent optional properties. Coordinate this with the contract compatibility rules before changing payloads.

Follow the source's dedicated metrics components instead of registering instruments throughout services. Use bounded labels such as outcome, operation, or partition. Record request IDs in structured logs, not metric labels. Keep message bodies and credentials out of logs. Protect Actuator metrics independently from application authentication.

Track SQL commit latency, request outcomes, Rabbit backlog age, and outbox pending age through the relevant component. Polling loops, retry limits, leases, retention, and batch sizes are validated configuration, not literals scattered through handlers.

## Testing and completion checks

Mirror production packages under `api/src/test/kotlin`. Use `<Subject>Tests` and backtick behavior names, such as `` `duplicate send returns the saved result` ``. Keep fixtures local to a test family. Extract a fixture helper only when several tests need it.

- Unit tests instantiate concrete services with mocked repository/integration interfaces, following `UploadSessionServiceTests`. Use Mockito where interaction matters, and `kotlin.test` or JUnit assertions for results and errors. Verify absence of writes on rejected/replayed paths when that is the behavior under test.
- Test domain invariants and pure mapping without a Spring context. Test serialization against the configured mapper or an equivalent configuration; a default mapper can hide production decoding differences.
- Use real PostgreSQL with Testcontainers for transactions, constraints, jOOQ mappings, locking, and concurrent idempotency. Mock jOOQ connections can test batch construction, as `OutboxPublisherTests` does, but cannot prove locking or rollback behavior.
- Use `@SpringBootTest` with a random port and a real HTTP client for API behavior, as `AssetApiTests` does. Share container wiring through a `@TestConfiguration`, `@ServiceConnection`, and dynamic properties. Add Redis to the PostgreSQL/Rabbit test environment when testing relay behavior.
- Inject a fixed or mutable clock for expiry and lease tests. Use latches or bounded Awaitility conditions for concurrency and asynchronous behavior. Give every wait a timeout.
- Cover matching retries, conflicting request IDs, concurrent sends, membership revocation, rollback of all send writes, commit-before-ACK redelivery, relay lease recovery, and publication-before-completion crashes. Assert durable state as well as responses.
- Split API integration tests by capability and failure scenario instead of copying the reference's large `AssetApiTests.kt` into one growing Messenger test file.

When the API is scaffolded, use the reference's check command from the repository root:

```sh
./api/gradlew -p api test ktlintCheck --no-daemon
```

For schema changes, apply migrations, run `./api/gradlew -p api jooqCodegen`, and inspect generated changes. For payload changes, follow the generation and compatibility checks in [contracts.md](contracts.md). These are implementation requirements; this documentation-only repository does not yet contain these commands.

## Source examples

| Pattern | Files inspected in the reference repository |
| --- | --- |
| Interface boundary and typed SQL | `K/asset/repository/FileAssetRepository.kt`, `JooqFileAssetRepository.kt`, `JooqUploadSessionRepository.kt` |
| Integration abstraction | `K/asset/integration/ObjectStorage.kt`, `integration/dto/*`, `integration/s3/S3ObjectStorage.kt` |
| Service split, request naming, idempotency | `K/asset/service/UploadSessionService.kt`, `UploadSessionActionsService.kt`, `FileAssetService.kt` |
| Transactions and transition metrics | `K/asset/service/AssetPreparationService.kt`, `UploadSessionExpirationService.kt`, `AssetCleanupService.kt` |
| Thin HTTP boundary and payload families | `K/asset/web/controller/*`, `K/asset/web/payload/*` |
| Models and explicit conversions | `K/asset/model/FileAsset.kt`, `AssetVariant.kt`, `UploadSession.kt`, `FileAssetId.kt`, `K/asset/dto/CompletedUploadDto.kt` |
| Topology, visibility, consumption | `K/infrastructure/messaging/AssetMessaging.kt`, `MessageRoute.kt`, `QueueRoute.kt`, `MessageConsumption.kt` |
| Feature publishers and outbox | `K/asset/messaging/publisher/*`, `K/infrastructure/outbox/*` |
| Shared errors and helpers | `K/shared/web/*`, `K/shared/integration/DependencyUnavailableException.kt`, `K/shared/id/UlidGenerator.kt`, `K/shared/crypto/Hashing.kt` |
| Test boundaries | `T/asset/service/UploadSessionServiceTests.kt`, `T/asset/messaging/publisher/OutboxPublisherTests.kt`, `T/JooqIntegrationTests.kt`, `T/asset/AssetApiTests.kt`, `T/TestcontainersConfig.kt` |
