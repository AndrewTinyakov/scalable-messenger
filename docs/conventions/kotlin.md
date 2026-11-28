# Kotlin conventions

These rules apply to the `api`, `command-processor`, `outbox-publisher` and `shared` modules. The architecture tests and the `checkKotlinComments` and `checkJooqPlainSql` tasks enforce the rules marked _checked_. Review covers the rest.

## Packages and files

- Feature packages sit at the package root beside `infrastructure` and `shared`. A feature contains only layer packages: `config`, `model`, `repository`, `service`, `scheduling`, `monitoring`, `messaging`, `grpc`, `web/controller` and `web/payload`. _Checked._
- When a layer package gets crowded, split it into short sub-feature packages named for a responsibility, such as `chat/repository/membership`.
- `infrastructure/<concern>` holds one technical concern and stays flat until a responsibility split earns its place.
- Place a declaration in the feature whose lifecycle and contract it belongs to. For example, the Kotlin `ws` feature owns WebSocket ticket issuance and gateway authorization.
- Keep code used by one module in that module. `shared` holds only what several modules use.
- Declare one class, interface, object or enum per file and name the file after it. Only `web/payload` files may hold several. A sealed type keeps its cases nested. Move other nested types to their own file in the matching layer package. _Checked._
- Keep files focused. A file approaching 400 lines is a prompt to look for a cohesive split.

## Services and boundaries

- Give each service one public method per operation, taking plain typed parameters. Command objects that bundle several operations are replaced by one method per operation.
- Classes in `service` are Spring beans named `*Service`. _Checked._
- Value types, cursors and pure domain rules live in `model`. A model reports validity, and the calling service chooses the HTTP error.
- HTTP payloads stay in `web/payload`. Controllers convert payloads to typed parameters and build responses from domain models. `model` and `repository` never reference payload types. _Checked._
- `@Scheduled` methods live in `*Scheduler` classes under `scheduling`, and each calls one service operation. _Checked._
- Each feature records metrics through one `*Metrics` class under `monitoring`. Its methods are named for typed domain events, such as `ReadMetrics.advanced(...)`. Meters are registered once at startup. HTTP latency and errors come from Spring's `http.server.requests`. _Location checked._
- Record a success metric for a database write only after its transaction commits.
- Configuration is split by feature into `config` classes and bound through `@ConfigurationProperties`. Tunable values, password settings, endpoint rules and CORS lists live in YAML. A shared bound is a named constant in the module that owns its meaning.
- Validate single and batch inputs through one pipeline with the same precedence.
- Remove wrappers that add nothing. Break a long transactional use case into named private steps inside the same transaction.

## Types and errors

- Use the typed IDs (`ChatId`, `UserId`, `MessageId`, ...) through models, services and repositories. Convert raw values at the transport boundary.
- Closed vocabularies are Kotlin enums backed by native PostgreSQL enums. New HTTP values use the enum's default uppercase names.
- Protocol values, queue names and framework keys come from enums, generated contract values or library constants, such as `RoomAddress` builders and `CommandTopology`.
- Enforce construction invariants with `init` and one `require` per condition. Assign the result of an effectful call first, then `check` it.
- Use named arguments in business logic wherever argument roles are not obvious from the values.
- Errors are Spring Problem Details. Codes are `UPPER_SNAKE_CASE` and reserved for outcomes the client acts on. Field validation uses one `VALIDATION_FAILED` code with per-field details.
- Spring placeholders use multi-dollar strings: `$$"${local.server.port}"`.
- Replace deprecated calls with their supported APIs.

## Persistence and jOOQ

- Build every query from the jOOQ tables generated from Flyway migrations and jOOQ's typed DSL. When jOOQ has no builder for a PostgreSQL construct, compose a typed expression: `postgresFunction(name, SQLDataType, args...)`, `DSL.cast` or a generated routine. jOOQ's plain-SQL entry points, such as `DSL.field(String)`, `DSL.condition(String)`, `resultQuery(String)` and `execute(String)`, stay out of the codebase, including templates with bound placeholders. So do SQL strings sent through JDBC `Statement`, `Connection.prepareStatement` or Spring's `JdbcTemplate`. _Checked._
- A statement jOOQ has no builder for, such as `LISTEN`, `ANALYZE` or `EXPLAIN (ANALYZE, BUFFERS)`, gets a typed function in `infrastructure/database/PostgresStatements`, which takes generated tables, `Name`s and `Query`s. It is the only class allowed to write SQL keywords and run rendered SQL over JDBC. Prefer a PostgreSQL function through `postgresFunction`, such as `pg_notify` or `set_config`, when one exists. _Checked._
- When a PostgreSQL feature can only be written as plain SQL, keep the typed alternative and record the trade-off in the PR.
- SQL and record mapping live in repositories. Repositories take typed inputs and return domain models through private `toModel()` mappers. jOOQ types stay out of services. _Checked for services._
- A repository returns what it fetched and lets the service decide. Each method does the one persistence operation its name describes. The service coordinates multiple steps, unless one atomic query is deliberate.
- Repository interfaces sit at the persistence seam, and `Jooq*Repository` implements the interface of the same name without the prefix. _Checked._
- Name repositories after the data they own, such as `UserRepository` and `SessionRepository`. Related repositories share a domain prefix, such as `MessageVisibilityRepository`.
- Take a row lock only where the operation needs it, through a method named `find...ForUpdate`.
- Avoid round trips. Reuse rows already fetched or returned, and batch writes where measurements support it.
- Database observability is global, through the jOOQ listener. Repositories use plain `tx.execute { ... }` without per-call labels.
- Database routing stays generic. A service chooses the read consistency it needs through `ReadTransactions`, and features never touch connection pools directly. Application work goes through PgBouncer in transaction pooling mode. Flyway and the publisher's `LISTEN` connection use direct PostgreSQL connections. See [chat sequences and replica reads](../adr/0005-chat-sequences-and-replica-reads.md).

## Transactions and events

- Transactions are explicit `TransactionTemplate` calls. `@Transactional` is not used. _Checked._
- Preserve SQL-enforced request deduplication and membership checks. The transaction contains the message, the request result, the chat sequence and the outbox events. Consumed commands are acknowledged after commit.
- Durable events go through a feature outbox class, such as `SessionOutbox.enqueueRevoked(...)`, called in the transaction that changes the data. `Publisher` names code that actually sends to a transport.
- Allocate a chat sequence for shared chat events and a member sequence for private in-chat events, on the existing chat and member rows, in the same transaction as the event.
- Model lifecycles with explicit states and transitions rather than combinations of flags and nullable fields. See [state machines](../state-machines.md).

## Naming

- Use the vocabulary in [CONTEXT.md](../../CONTEXT.md) in code, and one name per role across features: a `SendRequest` variable is `request`.
- Name injected dependencies by role: `repository`, `service`, `mapper` and `tx` when unambiguous, otherwise qualified, such as `userRepository`.
- Name session models for the stage they represent. They carry identity and the user ID, not display data.

## Sessions and clients

- HTTP sessions are stateful and opaque, with sliding expiry. Each device's session appears in the session list and can be revoked.
- A live socket learns about revocation promptly through the outbox, and the gateway revalidates its sessions in jittered batches as a backstop.
- Clients refresh chat state for a change that affects the viewer or a detected sequence gap, through the versioned `/state` route, rather than on every event or timer.
