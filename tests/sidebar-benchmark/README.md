This benchmark is opt-in. Its Kotlin source set is separate from `test`, so default API test runs do not compile or discover it. PostgreSQL is the only service required.

From the repository root:

1. Run `docker compose -f tests/sidebar-benchmark/compose.yaml up -d --wait`.
2. Apply the migrations with Flyway to `jdbc:postgresql://localhost:25457/messenger`, username and password `messenger`. Alternatively, on a fresh database apply the SQL migrations in numeric order through `docker compose -f tests/sidebar-benchmark/compose.yaml exec -T postgres psql -U messenger -v ON_ERROR_STOP=1`, without wrapping V11 in a transaction.
3. Seed with `docker compose -f tests/sidebar-benchmark/compose.yaml exec -T postgres psql -U messenger -v ON_ERROR_STOP=1 < tests/sidebar-benchmark/sidebar-seed.sql`.
4. Run `SIDEBAR_BENCH_DB_URL=jdbc:postgresql://localhost:25457/messenger ./kotlin/gradlew -p kotlin :api:sidebarBenchmark --rerun-tasks`.
5. Run `docker compose -f tests/sidebar-benchmark/compose.yaml down -v` afterwards.

The test captures the emitted jOOQ query in `tests/sidebar-benchmark/sidebar-page.sql` and writes measured plans and timings to `docs/evidence/`. The captured SQL can also be executed directly with `EXPLAIN (ANALYZE, BUFFERS)`. The fixture includes a million-message group, 5,200 direct chats, and personal deletion ranges. Use a fresh database for each seed run.

For the separately committed activity backfill measurement, run `tests/chat-activity-backfill/run.sh`. It provisions and removes its own isolated container automatically.
