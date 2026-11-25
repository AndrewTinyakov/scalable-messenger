# Repository rules

Read [CONTEXT.md](CONTEXT.md) for terms and [the broker decision](docs/adr/0001-messenger-broker-split.md) before changing delivery or recovery guarantees.

- Keep code self-explanatory. Add comments only when requested.
- Put Kotlin features at the package root, beside `infrastructure` and `shared`. A feature contains only layer packages (`config`, `model`, `repository`, `service`, `scheduling`, `monitoring`, `messaging`, `grpc`, `web/controller`, `web/payload`), never sub-features. Split a crowded layer package into short sub-feature packages.
- Give services one public method per operation that takes plain parameters, not command objects. Use typed IDs, generated jOOQ tables, and interfaces at persistence or transport seams. Keep SQL in repositories and transactions explicit through `TransactionTemplate`.
- Declare one class, interface, object or enum per file, named after it. Only `web/payload` files may hold several. A sealed type keeps its cases nested; move other nested types to their own file in the matching layer package.
- Preserve SQL-enforced request deduplication, membership checks, and the transaction containing the message, request result, chat sequence, and outbox events. ACK consumed commands after commit.
- Keep Go interfaces in consuming packages. Give each socket one reader and one writer, bound queues by items and bytes, propagate cancellation, and join owned goroutines on shutdown. Run the race detector for concurrency changes.
- Test existing interfaces. Use real infrastructure for transaction and broker guarantees; run checks in CI.

Generate HTTP models from Kotlin controllers/payloads, jOOQ tables from Flyway migrations, broker models from AsyncAPI schemas in `contracts/`, and gRPC models from `contracts/grpc/chat_authorization.proto`. Change sources or generators, then regenerate affected languages. Decode external data strictly and share wire fixtures. SQL chat sequences travel as decimal strings; Redis cursors are separate.
