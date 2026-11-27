# Testing and tooling conventions

## Tests

- Unit and integration tests live in their own project. Cross-system end-to-end and load tests live under `tests/`.
- Test through existing interfaces, and use real PostgreSQL, RabbitMQ and Redis for transaction, broker and recovery guarantees. Broker tests go through the consumer and assert ACK and rejection outcomes.
- Behaviour that crosses a wire or persistence boundary gets a regression test, ideally sharing fixtures with `contracts/`.
- Split a large test file only where its tests form cohesive groups.
- Load workloads are realistic, deterministic for a given seed from the client's perspective, and configurable for heavier profiles. Load generation scales separately from the services. Compare before and after on equivalent profiles and report environment differences.
- A load driver treats outcomes the real client treats as normal, such as a deleted jump target, as normal.

## Tooling

- Format through the project commands: `npm run format` for Go imports, Kotlin and the client. CI runs the matching `format:check`.
- Call standard tools directly. Add a wrapper script only when it adds behaviour the tool lacks.
- Grafana dashboards are maintained as JSON in `deploy/grafana`.
- When a call wraps its arguments, put a short chained call on the line with the closing parenthesis, as in `).toOutboxMessage(mapper)`. `kotlin/.editorconfig` stops IntelliJ and ktlint from splitting that layout, but neither joins a split chain, so reviewers enforce it. Check both forms before changing formatter settings.
- Generated code, including jOOQ, AsyncAPI, OpenAPI and gRPC models, comes from its source. Change the source or the generator, then regenerate.

## Documentation

- Update the affected ADR paragraphs and `CONTEXT.md` in the change that alters what they describe. Delete a wholly stale document; git keeps its history.
- Design rationale that names and tests cannot carry goes in `docs/`, not in source comments.
