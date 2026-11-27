# Database batching and username search

Investigated on 2026-10-20 against the working tree and primary documentation. The initial research below describes the pre-change code and proposed sketches. The implementation results at the end record the changes subsequently made and the search-plan experiment.

## Recommendations

1. Combine membership deletion and its conditional counter decrement in one data-modifying CTE. Keep the owner lock and both removal outbox events in the existing `TransactionTemplate` transaction.
2. Keep the existing multi-row member and outbox inserts. Reduce repeated counter updates, then measure an explicit JDBC batch for the remaining writes whose inputs are already known. Avoid wrapping existing repositories in transparent `batched`, because their immediate row-count checks would break.
3. Reduce `ChatService.get` to a purpose-built authorized read that includes the stored member count. Preserve its consistent snapshot. Do not spread that transaction across executor threads.
4. For the present literal username substring lookup, benchmark a `pg_trgm` GIN index while retaining `LIKE`. PlanetScale's new extension is TIN. It supports term wildcards, but adopting it also introduces TINQL semantics and a PlanetScale production dependency.

These are implementation recommendations inferred from the code and the documented behavior below. They do not establish that database round trips currently dominate endpoint latency.

## Installed stack and current guarantees

The API uses Spring MVC and JDBC. [The API build](../../kotlin/api/build.gradle.kts) and [shared build](../../kotlin/shared/build.gradle.kts) select Spring Boot 4.1.1. `./gradlew :api:dependencies --configuration runtimeClasspath` and targeted `:api:dependencyInsight` calls resolved:

| Component | Resolved version |
| --- | --- |
| jOOQ runtime and code generator | 3.21.7 |
| PostgreSQL JDBC driver | 42.7.13 |
| Spring JDBC and Spring TX | 7.0.9 |
| HikariCP | 7.0.2 |
| Java toolchain | 25 |
| Development and integration-test database | `postgres:19-alpine` |

[compose.yaml](../../compose.yaml) and [the integration-test base](../../kotlin/api/src/test/kotlin/com/andrewtinyakov/messenger/shared/MessengerIntegrationTest.kt) specify that database image. The minor database version is not pinned. [API configuration](../../kotlin/api/src/main/resources/application.yaml) sets no explicit Hikari pool limit or `reWriteBatchedInserts` property, and the checked compose JDBC URL has no driver options. Deployment overrides can change those settings.

[The initial migration](../../kotlin/shared/src/main/resources/db/migration/V1__messenger.sql) enforces member uniqueness, foreign keys, a bounded nonnegative member count, request deduplication, and unique chat sequences. [The broker decision](../adr/0001-messenger-broker-split.md) requires message, request result, sequence allocation, and outbox events to commit together. An optimization must preserve those boundaries and the command ACK after commit.

## What JDBC batching changes

A JDBC batch can contain different mutation statements, or one prepared statement with repeated bind sets. jOOQ exposes both forms through `DSLContext.batch`. A transaction supplies atomic commit or rollback; a batch alone does not replace it. The caller receives update counts after execution, so a batch cannot make a Kotlin branch between its first and second statements. [jOOQ batch documentation](https://www.jooq.org/doc/latest/manual/sql-execution/batch-execution/)

```kotlin
tx.executeWithoutResult {
    val counts = db.batch(insertChat, insertMembers, insertEvents).execute()
    validateExpectedCounts(counts)
}
```

All three query objects must exist before `execute`. Their inputs must already be known, and validation failure must escape the transaction callback so it rolls back. This sketch proposes a repository-level operation; it does not mean exposing query objects through the service interface.

Keep exact-count invariants explicit when switching APIs. JDBC permits `SUCCESS_NO_INFO` when a successful batch command has no available row count, and failures can produce `BatchUpdateException`. Unknown counts do not prove that exactly one row changed. Verify the installed driver's chosen batch mode and fail rather than silently accepting an unknown count where correctness requires an exact one. [Java 25 JDBC batch contract](https://docs.oracle.com/en/java/javase/25/docs/api/java.sql/java/sql/Statement.html#executeBatch())

In jOOQ 3.21.7, the heterogeneous batch implementation renders the SQL, adds each statement to a JDBC `Statement`, and calls `executeBatch`. That is still several SQL statements. [jOOQ 3.21.7 `BatchMultiple` source](https://raw.githubusercontent.com/jOOQ/jOOQ/version-3.21.7/jOOQ/src/main/java/org/jooq/impl/BatchMultiple.java)

PgJDBC 42.7.13 sends the batch's queries before its final flush and response processing. It can flush earlier when estimated response buffering becomes too large. This can remove a separate client wait for each small statement. It does not promise exactly one TCP packet or one wire exchange for every batch. Transaction setup, commit, error handling, and driver flushes remain separate concerns. [PgJDBC 42.7.13 `QueryExecutorImpl`, especially lines 630 to 655 and `flushIfDeadlockRisk`](https://raw.githubusercontent.com/pgjdbc/pgjdbc/REL42.7.13/pgjdbc/src/main/java/org/postgresql/core/v3/QueryExecutorImpl.java)

| Approach | Database work | Client waits | Parallel query execution |
| --- | --- | --- | --- |
| Two sequential `execute` calls | Two statements | Usually one result wait per call | No |
| One JDBC batch containing both | Two ordered statements | Can share sending and response processing | No application-level parallelism |
| One `INSERT ... VALUES (...), (...)` | One multi-row statement | One query result wait | No application-level parallelism |
| One data-modifying CTE | One statement expressing dependent mutations | One query result wait | Do not depend on sibling CTE execution order |
| Two reads on separate connections | Two statements | Waits can overlap | Yes, subject to server resources |

This table describes the proposed execution shapes, not measured packet counts. A database may also choose internal parallel workers for an individual eligible query.

`reWriteBatchedInserts` defaults to false and combines compatible repeated inserts into multi-row insert SQL. It does not combine an arbitrary delete with a counter update. The member and outbox repositories already construct multi-row SQL, so enabling it would not improve those existing inserts by itself. [PgJDBC connection properties](https://jdbc.postgresql.org/documentation/use/)

Avoid `DSLContext.batched` as a blanket wrapper. It buffers consecutive identical SQL and flushes on SQL changes or reads. Delayed `executeUpdate` calls report zero before execution, and queries returning results prevent batching. This conflicts with this project's immediate `check(inserted == ...)` and `check(updated == 1)` checks, and changing SQL between members and counters would force flushing anyway. [jOOQ batched connection documentation](https://www.jooq.org/doc/latest/manual/sql-execution/batched-connection/)

## Delete membership and update its counter

[`JooqChatRepository.deleteMember`](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/repository/JooqChatRepository.kt) currently does:

```text
DELETE membership, wait for row count
if exactly one row was deleted:
    UPDATE chat counter, wait for row count
```

[`ChatMembershipService.removeMember`](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/ChatMembershipService.kt) first locks the group chat row, checks ownership and the protected owner membership, calls `deleteMember`, and enqueues two removal events in the same transaction.

A blind batch of `DELETE` followed by `member_count = member_count - 1` changes the repository's behavior. If the member is missing, the delete affects zero rows but the update still runs. A caller could validate the first batch count and force rollback before commit, but then rollback becomes essential to compensate for a mutation that should never have happened. It can also encounter a counter constraint failure before reporting the intended missing-member error. Keep the conditional behavior in SQL instead.

Proposed single statement:

```sql
WITH removed AS (
    DELETE FROM chat_members
    WHERE chat_id = :chat_id AND user_id = :user_id
    RETURNING chat_id
)
UPDATE chats AS c
SET member_count = c.member_count - 1
FROM removed AS r
WHERE c.id = r.chat_id
RETURNING c.id;
```

The membership primary key limits `removed` to one row. An empty `removed` result cannot decrement anything. A returned chat ID means success; no row means `false`, preserving the existing interface and missing-member handling. Counter constraint failures still fail the transaction. Keep the chat row lock before this statement, then insert the removal outbox events before commit.

Data-modifying CTEs share a statement snapshot. Sibling statements cannot observe each other's table changes through ordinary scans; communicate dependencies through `RETURNING`, as this sketch does. Do not assume writing a CTE earlier in the SQL imposes execution order. [PostgreSQL 17 data-modifying CTE documentation](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING)

Prefer this explicit dependency over a database trigger for this repository. A trigger would also require migration and generated-code review and would hide counter writes from the existing repository methods. That is a design recommendation, not a PostgreSQL restriction.

## Group creation and membership insertion

[`ChatService.createGroup`](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/ChatService.kt) validates user existence, locks users in ID order, checks each user's group capacity, inserts the group, inserts members, and enqueues one creation event per member. Its final `get` occurs after commit.

The existing mutation shapes are already bounded:

- `insertMembers` writes up to 500 rows per `INSERT`, then increments `chats.member_count` once per chunk.
- `JooqOutboxRepository.enqueue` writes up to 500 events per `INSERT`.
- `notifyCreated` also chunks before calling `enqueue`. The repository's own chunking means this outer chunking is redundant for query size, though it does not cause one insert per event.

For `n` initial members and `k = ceil(n / 500)`, the mutation phase uses `1 + 3k` statements: one group insert, `k` member inserts, `k` counter updates, and `k` outbox inserts. A group with 1,000 initial members therefore uses seven mutation statements, followed by the response reads. Validation, capacity queries, transaction setup, and commit are excluded from that count.

Two reasonable changes, in increasing order of scope:

1. Insert all bounded chunks, validate each insert count, then update the counter once by the total inserted membership count. For 1,000 members this reduces seven mutation statements to six. Keep every step inside the existing transaction.
2. Add a specific repository operation for creating a group with known initial members and events. Initialize the new chat's count to `n`, then execute ordered group, member, and outbox inserts as an explicit heterogeneous batch. This uses `1 + 2k` SQL statements and can reduce client waits further. Validate all expected counts before committing. Do not call the old `insertMembers` counter-maintaining method afterward.

Application-generated chat and event IDs make the second option possible without a database-generated ID round trip. The parent chat insert must precede membership inserts for their foreign key. Preserve the ordered user locks and capacity check before mutation. Keep group creation and outbox persistence in one transaction. A new repository use case should own these mechanics; avoid making services assemble arbitrary SQL.

For adding members to an existing chat, an alternative combines each member insert and count update through `RETURNING`:

```sql
WITH inserted AS (
    INSERT INTO chat_members (chat_id, user_id)
    VALUES (:chat_id, :user_1), (:chat_id, :user_2)
    RETURNING chat_id
), totals AS (
    SELECT chat_id, count(*)::integer AS n
    FROM inserted
    GROUP BY chat_id
)
UPDATE chats AS c
SET member_count = c.member_count + totals.n
FROM totals
WHERE c.id = totals.chat_id
RETURNING totals.n;
```

Require the returned count to equal the expected chunk size. If a future implementation adds `ON CONFLICT DO NOTHING`, count the actual inserted rows and notify only those actual additions. Counting requested rows and emitting requested events would be wrong after a conflict. The current code rejects duplicate inserts and filters existing members while holding the group lock, so no conflict-skipping behavior is currently required.

The 500-row limit bounds parameters and statement size. Batch several chunks only with a separate bound on the batch's aggregate rows and payload bytes. A batch containing many JSON outbox payloads can consume substantial client memory even when every individual insert is small. The right bound needs measurement.

## Other concrete candidates

These classifications come from the current service and repository implementations. They identify possible changes, not approved changes to their interfaces.

| Site | Current behavior | Recommendation |
| --- | --- | --- |
| `ChatService.get` | Membership check, chat row, member preview, stored count in four SELECTs under repeatable read | Return the chat plus `member_count` from one authorized chat query, then fetch preview in the same transaction, or aggregate preview in that one query. Preserve missing-chat and unauthorized responses. |
| `ChatService.list` | Page query already includes count, followed by one bulk direct-member query | Already avoids a per-chat query loop. Second query depends on IDs from the first, so launching both together is not useful. Consider one SQL aggregation only if plans justify it. |
| `ChatService.addMembers` | Owner lock, user existence check, existing membership set, count, ordered user locks, group counts, chunked writes | Return owner and count from the lock query. Combine user existence validation with the locked-user result where it preserves error behavior. Keep lock and capacity dependencies sequential. Then use the membership insertion options above. |
| `AuthenticationService.register` | User insert then session insert in one transaction, with IDs already generated | Small explicit ordered batch candidate through a repository registration operation. Hash the password before opening the transaction, as today. |
| `AuthenticationService.login` | Read user, verify password, insert session | Dependent work. Session creation must wait for authentication. No useful blind batch. |
| `AuthenticationService.logout` | `DELETE ... RETURNING user_id`, then conditional revocation event | Event payload depends on the returned user ID. Keep the current clear sequence or use a carefully designed SQL dependency; do not enqueue for a missing session. |
| `MessageHistoryService.messages` | Membership check, then a history query that also contains an SQL membership predicate | Keep SQL authorization. A purpose-built query could return authorization plus an empty or populated page in one statement. Simply deleting the first check loses the distinction between no messages and no membership. |
| `MessageHistoryService.statuses` | Up to 100 IDs in one sender-scoped `IN` lookup | Already a set-based read. Do not replace it with 100 parallel SELECTs. |
| `DirectChatService.createForFirstMessage` | Pair lock and lookup, then new chat, two members, counter update, and one multi-row outbox insert | After the lookup establishes creation, known-ID writes can share a repository batch; a specialized creation operation can initialize count to two. Preserve pair lock, uniqueness, and the enclosing first-message transaction. |
| `MessageSendService.processInTransaction` | Deduplication lock and lookup, authorization, sequence returning, message, result, room lookup, outbox | Sequence allocation and authorization are dependencies. After the sequence and rooms are known, message, result, and event inserts are batching candidates within the same transaction. Preserve all current SQL guarantees and ACK after commit. |
| `JooqOutboxRepository.claim` | Locked `SKIP LOCKED` selection followed by bulk lease update | Good `WITH picked AS (...) UPDATE ... FROM picked RETURNING ...` candidate. Preserve lease conditions, limit, ordering, and earlier unpublished group-event exclusion. This belongs to the publisher, not the HTTP API. |
| `JooqOutboxRepository.complete` and `enqueue` | Bulk delete by IDs and multi-row inserts | Already set-based. Measure before adding more machinery. |
| `groupMemberships`, `findMembersByChatIds`, `groupCountsByUser`, `countExisting` | One query over a collection | Already bulk reads; retain them. |

Relevant sources are [chat service](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/ChatService.kt), [authentication service](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/service/AuthenticationService.kt), [history service](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/message/service/MessageHistoryService.kt), [direct chat service](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/chat/service/DirectChatService.kt), [send processor](../../kotlin/command-processor/src/main/kotlin/com/andrewtinyakov/messenger/message/service/MessageSendService.kt), and [outbox repository](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/infrastructure/outbox/JooqOutboxRepository.kt).

## Independent reads and blocking

Independent reads can overlap on different connections. That can reduce the latency of one request when the server and pool have spare capacity. It also increases concurrent connection demand and work. Most reads in the table above either depend on an earlier result or participate in authorization, locking, or snapshot consistency, so there is little reason to add generic parallel execution to this API.

Spring's JDBC transaction manager binds a connection to the current thread. Sending repository calls from a `TransactionTemplate` callback to executor threads does not carry that transaction or snapshot into those threads. Explicitly passing its connection to both threads would share one JDBC session instead. PgJDBC does not guarantee connection methods are synchronized or thread-safe. [Spring JDBC transaction manager](https://docs.spring.io/spring-framework/docs/7.0.x/javadoc-api/org/springframework/jdbc/datasource/DataSourceTransactionManager.html), [PgJDBC threading documentation](https://jdbc.postgresql.org/documentation/thread/)

Spring Boot 4.1.1 wraps the datasource in `TransactionAwareDataSourceProxy` when constructing its jOOQ connection provider. I checked the installed sources JAR and the matching upstream tag. This explains why ordinary calls through the injected `DSLContext` join this project's same-thread `TransactionTemplate` transaction. A shared `DSLContext` does not itself imply one permanently shared connection. [Spring Boot 4.1.1 jOOQ auto-configuration source](https://raw.githubusercontent.com/spring-projects/spring-boot/v4.1.1/module/spring-boot-jooq/src/main/java/org/springframework/boot/jooq/autoconfigure/JooqAutoConfiguration.java)

There are two distinct goals:

- To stop a request thread waiting directly on JDBC, execute blocking reads on a bounded executor and return an asynchronous MVC response or composed future. A worker still blocks for each JDBC call. Calling `join` immediately on the request thread forfeits that part of the benefit. Use explicit timeouts and query cancellation, and do not assume cancelling a future automatically cancels the database statement.
- To use nonblocking database I/O, use a compatible nonblocking driver and transaction model. jOOQ's publishers still block when configured with JDBC; they become nonblocking with an R2DBC connection or connection factory. This would be a broader change than parallelizing two reads and conflicts with simply retaining the present imperative transaction arrangement. [jOOQ reactive fetching](https://www.jooq.org/doc/3.21/manual/sql-execution/fetching/reactive-fetching/)

For a future endpoint with truly independent reads, compose their results without an early blocking wait, run each on its own connection, and explicitly accept that separate transactions can observe different snapshots. Bound executor concurrency against the actual pool size. Two concurrent reads per request can consume roughly twice as many in-flight connections as one sequential request at that moment. Keep writes and reads requiring a shared snapshot on the transaction's thread. These are design consequences of the connection model, not evidence that asynchronous execution improves this workload.

## Username search and PlanetScale TIN

[`AuthenticationService.register`](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/service/AuthenticationService.kt) stores lowercase ASCII usernames matching `[a-z0-9_]{3,40}`. [`JooqUserRepository.search`](../../kotlin/shared/src/main/kotlin/com/andrewtinyakov/messenger/auth/repository/JooqUserRepository.kt) lowercases input, escapes `%` and `_`, uses `username LIKE '%query%'`, orders alphabetically, and returns at most 30 users. [`UserSearchService`](../../kotlin/api/src/main/kotlin/com/andrewtinyakov/messenger/auth/service/UserSearchService.kt) imposes a maximum length of 40 and no minimum. The migration has a unique B-tree username constraint and no trigram or full-text index.

### Keep literal substring semantics with pg_trgm

The narrowest proposed database change is:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX users_username_trgm_idx
ON users USING gin (username gin_trgm_ops);
```

Keep the `LIKE` predicate and alphabetical limit. PostgreSQL 17 documents GIN and GiST support for non-left-anchored `LIKE` and `ILIKE`. It extracts trigrams from the pattern, so patterns with no extractable trigrams can become full-index scans. Short, common, empty, or underscore-heavy queries therefore need explicit benchmark cases. The planner may still prefer another plan. The existing B-tree remains useful for uniqueness and equality lookup; a trigram GIN index does not supply alphabetical result order. [PostgreSQL 17 pg_trgm documentation](https://www.postgresql.org/docs/17/pgtrgm.html)

Before adding an index, settle the product behavior for empty queries and one- or two-character searches. Returning no results below three characters would reduce broad scans, but it changes today's behavior. Also test literal backslashes: the current expression escapes `%` and `_` but does not first escape the SQL LIKE escape character. Parameter binding prevents SQL injection; it does not make LIKE metacharacters literal. A username contains no backslash, but a query containing one can alter interpretation of the escaped pattern. This observation comes directly from the current pattern construction and needs focused behavior tests before changing it.

### Identify the new extension correctly

PlanetScale launched TIN as a GA release on September 16, 2026 for its Postgres and Neki databases. This is a current production offering, not an unreleased experiment. The latest release announcement found was TIN 1.0.6, dated October 8, 2026, adding stemming and improved top-k queries with tie breakers. Vendor benchmarks in that announcement use large document corpora, not this username workload. [TIN launch](https://planetscale.com/blog/introducing-tin), [TIN 1.0.6 announcement](https://planetscale.com/blog/tin-v106)

TIN adds `USING tin`, the `==>` operator, TINQL, and BM25 scoring. Its documentation lists `pg_textsearch` as a separate engine that is unavailable on PlanetScale. Do not use those names interchangeably. [PlanetScale search overview](https://planetscale.com/docs/postgres/search)

Production installation is documented for PlanetScale clusters. Local and CI usage uses Lead, which provides TIN-compatible SQL under the `tin` extension name for PostgreSQL 17 and 18. Lead deliberately scans table rows and cannot benchmark TIN performance. Plain `postgres:17-alpine` does not become TIN-capable just by adding a migration; it would need a different test image or extension installation. [TIN setup and local development documentation](https://planetscale.com/docs/postgres/search/get-started)

Lead's public repository has an AGPL-3.0 license and PostgreSQL 17/18 images for Linux amd64 and arm64. Its README refers to TIN's private source. I found no documented license or production distribution that permits installing the full TIN implementation into this repository's self-hosted database. Treat TIN production availability as a PlanetScale dependency unless the vendor provides other terms. Lead's public license does not establish a license for full TIN. This is an availability finding, not a legal interpretation. [Lead README](https://github.com/planetscale/lead/blob/main/README.md), [Lead license](https://github.com/planetscale/lead/blob/main/LICENSE)

For completeness, TigerData's `pg_textsearch` is a separate PostgreSQL-licensed BM25 extension supporting PostgreSQL 17 and 18, with Linux amd64/arm64 binaries. Its repository records a first GA 1.0.0 release and subsequent releases. It is not the new PlanetScale extension and does not remove the need to compare token search against the current substring contract. [pg_textsearch repository](https://github.com/timescale/pg_textsearch)

### TIN can match term substrings, but adoption needs a deliberate contract

TINQL supports `*` and `?` wildcards, including leading wildcards such as `*house`. Therefore `*drew*` can express substring matching within a dictionary term. A bare `drew` is a term query and does not preserve `%drew%` behavior. TINQL also interprets operators and reserved syntax, and empty input matches nothing. Construct a literal search expression and bind it as data; binding alone does not escape TINQL's query language. [TINQL reference](https://planetscale.com/docs/postgres/search/tinql)

TIN's default tokenizer splits at Unicode word boundaries and folds case and accents. It also offers a whitespace tokenizer, configurable folding, and optional stemming. For this project's ASCII usernames, a whitespace tokenizer with stemming disabled is a plausible way to retain each whole username as one term, then search with escaped surrounding wildcards. This is a proposed configuration, not a tested semantic equivalence. Verify underscores and queries spanning them before adopting it. A username is at most 40 ASCII bytes, below the documented default 256-byte token limit. [TIN index and tokenizer reference](https://planetscale.com/docs/postgres/search/reference/indexes)

| Search input and stored username | Current intended literal substring behavior | TIN migration check |
| --- | --- | --- |
| `drew` in `andrew` | Match | Bare term differs; test `*drew*` |
| `ann_` in `ann_smith` | Match literal underscore | Verify tokenizer retains it and wildcard query searches the same term |
| `_s` in `ann_smith` | Match across the underscore boundary | Must match identically; term splitting can change this |
| `%` | Match literal percent, so no valid username matches | Preserve literal handling rather than interpreting a wildcard language |
| Empty input | Current `LIKE '%%'` returns first 30 alphabetically | Decide whether to preserve or change explicitly |
| `AND`, `*`, `?`, quotes, backslash | Literal input to the username lookup | Escape or reject according to a defined API policy |

BM25 relevance is not presently part of the API contract. Keep alphabetical order if experimenting with TIN. Full-text capabilities may be useful for future message-body search, where words, phrases, and relevance have value; that is a separate feature and should be measured on an actual message corpus.

## Measurements and verification still needed

No batching or search performance experiment ran during this study. Before implementing the larger changes:

- Measure SQL statement count and end-to-end p50/p95/p99 for group creation and removal at realistic database RTT. Compare current execution, counter consolidation, explicit batch, and the delete CTE. Record setup and commit separately from mutation execution.
- Verify database wire behavior with PgJDBC 42.7.13 under the actual proxy and TLS configuration. jOOQ execution logs count statements; they do not prove the number of network waits.
- Track Hikari active, pending, and acquisition latency, PostgreSQL lock waits, statement time, CPU, WAL, and batch payload size. Existing dashboards already expose active and pending connections. Compare throughput under concurrent load, not only a single fast request.
- Check missing-member deletion leaves the count and outbox unchanged, repeated removal does not decrement twice, and concurrent sends/additions/removals preserve the current lock protocol. Fail a member or outbox insert and verify the whole transaction rolls back. Use real PostgreSQL for these guarantees.
- On representative username data, run `EXPLAIN (ANALYZE, BUFFERS)` with rare and common three-character substrings, two-character input, empty input, no match, underscores, and the alphabetical `LIMIT 30`. Compare index size and registration write cost as well as read latency.
- If evaluating TIN, use Lead for correctness fixtures and real TIN for performance. Pin PostgreSQL and extension versions. Compare literal-search results against current intended semantics, including escaping, then benchmark wildcard searches over usernames rather than assuming the published document-search results transfer.

The highest-confidence next implementation is the conditional delete CTE. Group counter consolidation is also small. A generic parallel-read framework and a full-text extension migration have weaker evidence for this API today.


## Implementation results

The follow-up implementation keeps ordinary chat reads separate from locked mutation reads. Additions and sends use `FOR NO KEY UPDATE`; removal reads owner state normally and serializes through its conditional counter update. The membership deletion and count decrement share a CTE. User capacity locks return fetched IDs and permit foreign-key key-share access. Group and direct creation use an ordered JDBC batch with a known initial count and bounded member/event chunks. Services still build events and own transactions.

| Operation | Previous SQL statements | Implemented SQL statements |
| --- | --- | --- |
| Authorized chat details | 4 | 1 |
| Successful member removal | 4 | 3 |
| Two-member group creation | 11 | 6 |
| 1,000-member group creation | 14 | 8 |
| Add up to 500 new members | 9 | 7 |
| Add 1,000 new members | 12 | 9 |
| Nonempty history page | 2 | 1 |
| Empty history page | 2 | 2 |
| Group authorization RPC | 2 | 1 |
| Fresh ten-group subscription batch | 22 | 2 |
| Existing-session logout | 3 | 2 |
| Nonempty outbox claim | 2 | 1 |

These are static statement counts, excluding transaction commands, internal constraint work, and the separate HTTP session lookup. Creation statements are submitted in one batch for the mutation phase. The WebSocket figure includes both current-session and membership checks and retains pre-attachment and post-attachment authorization. Existing subscription renewals keep one batch check. Pending group recipients retain generation-aware fail-closed behavior when stream continuity is lost.

Authentication now has separate user and session repositories. The authentication session has no username. The session response still fetches the current username, while register/login use their already known user. Logout deletes with `RETURNING`, validates any expected identity inside that transaction, and only then enqueues revocation. An identity mismatch or publication-row failure rolls back deletion.

The existing V1 migration now installs `pg_trgm` into the `extensions` schema and creates `users_username_trgm_idx`; jOOQ models were regenerated. Existing databases require recreation under the approved reset policy. Search retains literal substring matching, alphabetical order, and the 30-result limit, including short and empty inputs. Backslashes, underscores, and percent characters are escaped as literals.

A local PostgreSQL 17 experiment inserted 50,100 usernames and compared the same ordered, 30-result substring query before and after creating the index. For `andrew`, the indexed plan used a bitmap index scan, touched 18 shared blocks, and took 0.330 ms in that run. Without the index, the sequential scan touched 719 blocks and took 11.328 ms. A missing substring also used the index. Short and empty searches retained the ordered B-tree path and touched 33 blocks in both configurations. This is one local experiment with cache and scheduling effects, not an endpoint latency benchmark or a production speedup claim.

No generic parallel JDBC read mechanism, full-text search migration, or cross-request membership cache was introduced. Registration retains explicit user/session writes to keep their persistence interfaces separate. The specific chat creation batch and dependent mutation CTEs address the identified write paths.
