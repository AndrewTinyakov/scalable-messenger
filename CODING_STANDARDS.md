# Coding standards

These implementation defaults were agreed for the Messenger app. The domain vocabulary in CONTEXT.md and the accepted ADR govern behavior.

- Use strict TypeScript and validate external HTTP, WebSocket, broker, and persisted browser data with schemas. Treat parse failures as boundary errors.
- Keep message identity, request identity, conversation sequence, and Redis position distinct. Never infer application acknowledgment from publication.
- Keep SQL writes that establish saved state in one transaction. Acknowledge consumed commands only after commit. Retry with the same request ID.
- Keep API, gateway, worker, and relay independently runnable. SQL owns durable history; Redis history is expendable.
- Client dependencies flow from app to pages, widgets, features, entities, and shared. Import a slice through its public index. Shared code cannot depend on higher layers.
- Use small React components with one UI responsibility. Keep transport and state transitions outside render components. Use accessible names, keyboard controls, and visible focus states.
- Test public behavior at the agreed HTTP/WebSocket, durable command/recovery, and client message-state seams. Prefer real local services for integration tests. Isolate test queues from application queues.
- Run typechecking during implementation, targeted tests for each behavior, and the full suite before committing. Format with Prettier.
- Comments explain invariants and failure handling. Do not claim production capacity or fault tolerance without measurement.
