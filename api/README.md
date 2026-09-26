# Kotlin API

The API, command worker, and outbox relay share this Spring Boot image. Set `MESSENGER_ROLE` to `http`, `worker`, or `relay` for each process. Flyway owns the PostgreSQL schema; run `jooqCodegen` against a migrated database before changing generated jOOQ tables.

Send status is scoped to the authenticated sender, conversation, and request ID. A sender can read their own recorded `saved` or `rejected` result after group membership is revoked, so a queued command remains recoverable. An unknown request still requires active conversation membership and otherwise returns 404. History and live room authorization always require active membership.
