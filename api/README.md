# Kotlin applications

This Gradle build produces three Spring Boot binaries:

| Module | Purpose | Runtime dependencies |
| --- | --- | --- |
| Root `api` | Monolithic HTTP API plus internal gRPC group authorization: auth, users, chats, message history, and send status | PostgreSQL |
| `messenger-command-processor` | Consumes RabbitMQ send commands, saves messages, and writes Messenger outbox events | RabbitMQ, PostgreSQL |
| `messenger-outbox-publisher` | Claims Messenger outbox events and publishes them to Redis room streams and channels | PostgreSQL, Redis |

The `shared` library holds SQL repositories, domain models, generated contracts, and the outbox writer. It is not a deployable application. Each binary has its own entry point, dependencies, configuration, and Docker image. Flyway runs the single `shared/src/main/resources/db/migration/V1__messenger.sql` migration at startup; concurrent starts are coordinated by Flyway's database lock. The outbox table is `messenger_outbox_events`. Before regenerating jOOQ, start a database migrated by V1 and run `./gradlew jooqCodegen` from this directory.

Run `./gradlew test` for the Kotlin suite. `./gradlew :bootJar :messenger-command-processor:bootJar :messenger-outbox-publisher:bootJar` builds all three executables. The root system test exercises the API and processor together with a real PostgreSQL container; Compose exercises the separate processes.

Send status is scoped to the authenticated sender and request ID at `GET /v1/sends/{requestId}`. A sender can read their own recorded `saved` or `rejected` result after group membership is revoked or before a direct chat exists. An unknown request returns `unknown`. History and live room authorization require active membership. Selecting a direct recipient stays local to the client; the first send creates the chat and its first message in one SQL transaction.

`GET /v1/chats?limit=50&cursor=...` returns `{chats,nextCursor}` in membership join order; the cursor is opaque and the page limit is 100. `GET /v1/chats/{id}/messages?limit=50` returns the latest messages. Use `beforeSeq` to page older messages and `afterSeq` for forward recovery; both bounds are exclusive and cannot be sent together. The response includes `hasMore` and `nextSequence`. The outbox publisher deletes successful event rows in batches after Redis publication; failed and leased rows remain for retries.

The browser exchanges its opaque HTTP session for a signed WS ticket at `POST /v1/auth/ws-ticket`. WS nodes verify tickets locally and call `ChatAuthorization.ValidateSession` on connect to check the SQL session. `POST /v1/auth/logout` deletes the current session and inserts a `session_revoked` personal-room outbox event in one transaction. The API's private port 9090 also exposes `ChatAuthorization.AuthorizeGroup` from `contracts/grpc/chat_authorization.proto`; it verifies the ticket, active session, and current SQL group membership. Set the same `WS_TICKET_SECRET` on API and WS instances outside local development. Group additions use `POST /v1/chats/{id}/members` in batches of at most 1,000; the stored group count is capped at 100,000, and each user is limited to 200 group memberships.
