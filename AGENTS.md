# Project guidance

Read [CONTEXT.md](CONTEXT.md) for domain terminology and [the broker decision](docs/adr/0001-messenger-broker-split.md) for the selected architecture.

- Before implementing or reviewing Kotlin API, SQL repository, consumer, or outbox code, read [Kotlin API coding standards](docs/coding-standards/kotlin-api.md).
- Before implementing or reviewing Go WebSocket code, read [Go WebSocket coding standards](docs/coding-standards/go-websocket.md).
- Before changing HTTP endpoints, WebSocket frames, broker topology, serialization, schemas, or generated models, read [API and messaging contract standards](docs/coding-standards/contracts.md).

The standards derive from the file-upload-system project and identify Messenger-specific adaptations. This repository currently contains design documents; the application layouts and build commands in the standards are targets for implementation.
