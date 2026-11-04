# Scoped deletion runtime checks

Node 24 driver for the public HTTP/WebSocket deletion contract, plus controlled historical fixtures in its own disposable chats. It never adopts an existing chat. SQL setup is a storage/query fixture, not a message write-throughput benchmark.

Run only against the explicitly chosen disposable deployment. The database adapter verifies the Docker Compose project and `postgres` service labels before any SQL access. Defaults target project `messenger-browser`, API port 18081, WebSocket port 18082 and client origin port 18080. It creates three fresh accounts and logs the first account into a second distinct session. Credentials, fixture identities and raw reports must stay outside the repository with mode 0600.

```sh
node tests/scoped-deletion-load/main.mjs --phase setup \
  --state /tmp/messenger-deletion-1104/benchmark/fixture.json

node tests/scoped-deletion-load/main.mjs --phase run \
  --state /tmp/messenger-deletion-1104/benchmark/fixture.json \
  --report /tmp/messenger-deletion-1104/benchmark/run.json \
  --sizes 10000,100000,1000000 --repeats 20 --timeout 600

node --test tests/scoped-deletion-load/self-check.test.mjs
```

Setup uses public registration and login. Run creates new benchmark groups and a fresh direct identity. Use a new state for each complete run, because the functional direct-identity check requires a fresh pair. For an interrupted history-only investigation, `--skip-functional` leaves the prior direct fixture untouched and creates new history groups. `--api`, `--ws`, `--origin`, `--postgres` and `--project` override deployment settings. No service configuration is changed.

The functional checks prove self-only batches across two authenticated sessions, unaffected other-account history, hidden quotes, personal and global hints, retries and conflicting request IDs, atomic group rights, own-message removal and creator moderation, clear keeping the sidebar chat, chat hiding and resurfacing after a later send, permanent direct/group deletion, saved-request dedup after row deletion, and a fresh direct identity after global chat deletion. They use public responses and live notifications, not SQL mutation shortcuts.

A separate fresh 10K-row fixture measures maximum-size 100-ID SELF and EVERYONE message deletion through the public endpoint. Historical rows belong to another group member. SELF hides contiguous sequences 1 through 100 and must store exactly one merged range while retaining all shared rows. The creator's EVERYONE batch removes sequences 201 through 300 physically, proves absence for every session and checks retained neighbors. Each scope reports HTTP acceptance time, completed state and storage counts. This fixture stays separate from the history/purge fixtures, whose expected row counts are unchanged. SQL provisioning does not measure write throughput.

Each history fixture contains 10K, 100K or 1M rows with 128-byte bodies. Controlled SQL inserts historical rows into a new empty benchmark chat, sets its sequence, and separately installs a 90% hidden middle or 100 alternating singleton intervals. SQL setup does not model historical outbox or send-request retention. Ordinary sends during and after the fixture use the real WebSocket command path.

The driver measures latest, older, ascending, around a hidden anchor and bounded resolve requests. It verifies coverage, directional continuation and short intermediate pages under the 16-span budget. It captures `EXPLAIN ANALYZE BUFFERS` for repository-equivalent interval and message-span queries. These plans describe controlled SQL queries, not captured HTTP SQL traces. First-after-insert and repeated warm requests are identified separately; no cache flush occurs.

Global clear records acceptance latency separately from observed completion and rows per second. After physical completion, the driver separately waits for cleanup-job retirement and reports that wait. SQL verifies original message rows and plaintext outbox bodies are absent, the purge job is gone, and a later accepted send survives. Completion time includes 100 ms polling granularity and public checks. This does not establish erasure from WAL, backups, unacknowledged broker commands or already delivered packets.

The default purge timeout is 600 seconds. At four 500-row batches per second per API replica, two replicas have a theoretical maximum of 4K rows per second, so 1M rows need at least 250 seconds before other work. A timeout records a failure; it does not tune the worker budget or change the live workload.

A separate live group sends sequentially every 500 ms while history requests and purge run. It requires notifications on all four connected sessions, disconnects one recipient, sends while it is offline and proves public SQL recovery after reconnect. Historical fixture creation waits for that reconnect to finish, so concurrent setup cannot lose a group subscription. Backpressure reduces the offered rate. The report includes actual sends, reconnects, latency distributions, deployment image IDs and limits, host information, before/after Docker statistics, query plans, HTTP histograms and bounded metadata. It does not test browser gestures, focus or rendering.

Comparisons must use the same driver, size list, repeat count, limits, member/session count and deployment topology. This is a new feature workload with no invented pre-feature deletion baseline. The existing send-heavy benchmark supplies the separate baseline/candidate send comparison.
