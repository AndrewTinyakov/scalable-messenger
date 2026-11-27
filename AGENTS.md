# Repository rules

Read [CONTEXT.md](CONTEXT.md) for terms and [the broker decision](docs/adr/0001-messenger-broker-split.md) before changing delivery or recovery guarantees.

Before editing code, read the conventions for the area you change:

- Kotlin services, persistence and jOOQ: [docs/conventions/kotlin.md](docs/conventions/kotlin.md)
- Go gateway and load driver: [docs/conventions/go.md](docs/conventions/go.md)
- Tests, tooling, formatting and docs: [docs/conventions/testing-and-tooling.md](docs/conventions/testing-and-tooling.md)

These apply everywhere, and CI enforces the first two:

- Code is self-explanatory through names, types and tests. Source comments appear only where Andrew explicitly requests them, in every language and config format. Generated files and tool directives are the exceptions. Design rationale goes in `docs/`.
- Queries use generated jOOQ tables and jOOQ's typed DSL, extended with typed expressions where jOOQ lacks a builder. Kotlin holds no SQL strings, whether through jOOQ plain SQL, JDBC or `JdbcTemplate`. A statement jOOQ cannot build gets a typed function in `PostgresStatements`, the only file that writes SQL keywords.
- Generate HTTP models from Kotlin controllers and payloads, jOOQ tables from Flyway migrations, broker models from AsyncAPI schemas in `contracts/`, and gRPC models from `contracts/grpc/chat_authorization.proto`. Change sources or generators, then regenerate the affected languages. Decode external data strictly and share wire fixtures. SQL chat sequences travel as decimal strings; Redis cursors are separate.
- Preserve SQL-enforced request deduplication, membership checks and the transaction containing the message, request result, chat sequence and outbox events. Acknowledge consumed commands after commit.
- Delegated work follows these rules too. Check a delegate's changes against them before integrating.

Run the rule checks with `npm run check:rules` before committing.
