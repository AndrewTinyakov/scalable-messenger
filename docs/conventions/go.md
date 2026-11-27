# Go conventions

These rules apply to the `ws` gateway and the `tests/load/ws` driver. The comment check enforces the rule marked _checked_. Review covers the rest.

- Code carries its own explanation through names, small types and tests. Source comments are limited to tool directives such as `//go:build`. _Checked._
- Interfaces are small and declared in the package that consumes them. Concrete implementations stay with their provider.
- Constructors validate their input before starting registries, workers or other owned resources.
- Each socket has one reader and one writer. Queues are bounded by items and bytes. Cancellation propagates, and owned goroutines are joined on shutdown. Run the race detector for concurrency changes.
- Error codes, metric labels and protocol values come from typed vocabularies or generated contract values.
- Lifecycles are explicit states with defined transitions. See [state machines](../state-machines.md).
- Split a package's files by responsibility, such as admission, lifecycle, publication and buffering, while keeping work that must stay coordinated in one file.
- The WebSocket ticket is verified at the handshake. The gateway sends the connection's session ID to the Kotlin API over trusted internal gRPC for session and membership checks.
