# Chat summaries implementation handoff

This branch is a partial implementation. It is not ready to merge as fulfillment of the sidebar task.

Implemented:

- List and single-chat responses serialize `lastMessage` as null or `{ id, sequence, senderId, senderUsername, createdAt, bodyPreview, deleted }`. Sequence is a decimal string. The preview contains at most 160 Unicode characters. Globally removed rows are excluded, so returned summaries have `deleted: false`.
- The summary query applies global and personal clear cutoffs, merged personal exclusions, chat hiding and membership authorization. It joins users to return the sender username even when group list responses omit members. It runs as a correlated subquery within each existing chat query, without extra per-chat SQL round trips.
- Kotlin payloads generate the OpenAPI schema, which generates TypeScript models. `Chat` retains its generated alias. `lastMessage` is optional in the generated schema for source compatibility with existing draft and fixture literals; the server serializes it even when null. The client decoder validates summary fields and rejects extra fields and oversized previews.
- Received message, mutation, history and read hints coalesce summary refreshes for 500 ms. Pending work holds at most 100 distinct chats and runs batches of at most 10 requests. It updates existing directory entries with a shallow array pass and does not navigate or open message history. Overflow falls back to existing periodic directory reconciliation. Removed chats cannot be restored by a summary request started before removal. This does not establish subscriptions for unselected groups.
- `useMessenger` adds `reconnect: { nextRetryAt: number | null }`, `retryNow(): void`, `deleteChatById(chatId: string, scope: DeleteScope): Promise<void>`, and `clearChatHistory(chatId: string, scope: DeleteScope): Promise<void>`. Existing fields remain. Retry timestamps are epoch milliseconds. Immediate retry cancels a scheduled wait without resetting the existing backoff. Offline, revoked, disposed, connecting and connected states cannot create duplicate connections through retryNow.
- Arbitrary-chat deletion reuses the existing scoped deletion implementation and its bounded retry-ID cache. It does not require selecting or loading the target chat. Failed requests retain their IDs; successful requests release them. Existing selected-chat entry points still work.

Still missing:

- `unreadCount` and any cap metadata. No unread implementation, migration, maintained counter, cap-boundary tests or large-dataset EXPLAIN ANALYZE evidence is included. Sequence subtraction was deliberately not introduced. A limited query that filters out own or personally hidden rows can still scan an arbitrarily large prefix, so LIMIT alone would not satisfy the requested bound.
- Latest-activity list order and pagination. The list still orders by membership join timestamp and chat ID. The existing tied-key pagination test passes, but this is not evidence for activity-order pagination.
- Group sidebar delivery. The gateway still subscribes to selected group rooms. No bodyless sidebar channel or coalesced group hints have been added. Full message fanout per group member has not been introduced. Existing received hints refresh a row, but unselected group events can still wait for the existing periodic directory refresh.
- `sidebarPresence` and `watchSidebarPeers`. The existing presence coordinator still stores one watch per connection; a second existing watch command would replace the first. A separate bounded authorization/watch scope remains necessary. No presence contract or authorization changes are included.
- Immediate selected-chat unread badge clearing and cross-device unread clearing cannot be claimed without unread counts.
- The summary query has not been benchmarked against millions of messages or large personal exclusion sets. Its exclusion predicate can examine many hidden candidates. It should not be treated as satisfying a bounded-work guarantee for adversarial histories.
- New shared cross-language fixtures and CI configuration were not added. No delivery guarantee changed, so no ADR was added.

Validation:

- `JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home ./kotlin/gradlew -p kotlin :api:compileKotlin --console=plain`: passed.
- `JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home OPENAPI_PORT=19089 ./kotlin/gradlew -p kotlin :api:generateOpenApiDocs --console=plain`: passed. Its temporary API process stopped after generation.
- `PATH=/opt/homebrew/opt/node@26/bin:$PATH npm --prefix client run generate:api`: passed.
- `JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home ./kotlin/gradlew -p kotlin :api:test --tests '*ChatServiceTests' ktlintFormat --console=plain`: passed, 20 integration tests, zero skipped. The existing PostgreSQL Testcontainers seam ran on its own temporary container and cleaned up. The new visibility test checks the service against real PostgreSQL state, including personal exclusions, clear cutoffs, hiding, intentional sequence gaps and removal. It is not a replacement for transactional deletion tests through the deletion API.
- `JAVA_HOME=/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home ./kotlin/gradlew -p kotlin ktlintCheck --console=plain`: passed.
- `PATH=/opt/homebrew/opt/node@26/bin:$PATH npm --prefix client test`: passed, 25 files, 223 tests. Tests cover strict summary decoding, received-hint coalescing with senderUsername, unopened-chat operations and request-ID reuse, and reconnect scheduling/manual retry.
- `PATH=/opt/homebrew/opt/node@26/bin:$PATH npm --prefix client run typecheck`: passed.
- `go -C ws test -race ./...`: passed. No Go code changed; this does not validate the missing gateway features.
- Formatting was applied only to the changed client source files. An initial root-directory Prettier invocation could not resolve its client-local plugin; invoking it from client succeeded. Initial client testing required `npm --prefix client ci --ignore-scripts`; Node 26 was used for checks after the default Node 22 reported engine warnings.
- `git diff --check`: passed.

No prohibited visual files, client/package.json, client/src/main.tsx or existing browser-stack services were changed. No push, PR or merge was performed. No subagents were started. Review was local because the task prohibited delegation; independent review remains outstanding.

The redesign owner can use the summary shape and reconnect/deletion methods above. They must still replace the visual fallback text and render senderUsername themselves. They cannot rely on this branch for unread badges, group sidebar freshness, activity sorting or sidebar presence.
