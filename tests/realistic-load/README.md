# Realistic messenger load

Use Node 24 and a disposable local `messenger-bench` stack. The driver registers fresh accounts, creates chats and writes messages. It leaves those fixtures in the database. A failed setup can leave partial fixtures. The existing Go and feature drivers are independent.

## Plan and run

`smoke` has 20 users and two minutes of traffic, with a higher chance of rare actions. `users-200` and `users-1000` run for ten minutes. The profiles control persona shares, `devicesPerUser`, friend clusters, `groupsPerUser` and group sizes (`{min,max,share}`), history depth, lognormal session and visit lengths, burst sizes, text lengths, and feature rates. The largest profile includes two groups of at least 200 members.

```sh
work=/tmp/messenger-bench-1118/realistic-load
mkdir -p "$work"
umask 077

node tests/realistic-load/main.mjs plan \
  --profile tests/realistic-load/profiles/smoke.json --seed 1118 \
  --output "$work/smoke-plan.json"

node tests/realistic-load/main.mjs setup \
  --plan "$work/smoke-plan.json" --manifest "$work/smoke-sessions.json" \
  --compose-project messenger-bench --auth-rate 16

node tests/realistic-load/main.mjs run \
  --plan "$work/smoke-plan.json" --manifest "$work/smoke-sessions.json" \
  --report "$work/smoke-report.json" --auth-rate 16
```

Run from the repository root. `--compose-project` names the stack whose `postgres` service receives the seeded history; it defaults to `messenger`. The example's `--auth-rate 16` needs a stack whose API proxy allows it (see Limits). The API defaults to `http://localhost:8081/api`, the WebSocket to `ws://localhost:8082/ws`, and the browser origin to `http://localhost:8080`. Override these with `--api`, `--ws`, and `--origin`. All three URLs must address the loopback interface.

The planner reads only the profile and seed. It writes the full population, device assignments, chat membership, seed history and sorted timed actions. It writes to stdout when `--output` is absent. The runner rebuilds the plan and checks its fingerprint against the manifest. Earlier sends are referenced by action ID. Other actions can refer to a position in the device's history window. Wire request IDs, account IDs and cookie values are fresh for each fixture set. Use fresh setup for each comparison because running changes read positions, history, preferences and membership. If you must reuse a manifest, logout/login can change its cookie and leave the old manifest stale.

Setup uses register/login, group creation and the first direct send. It bulk-copies older messages into Postgres in one transaction, updates the chat sequences and activity, and checks the target chats' starting sequences. Fixture rows bypass the broker and don't produce live events. Credentials and cookies are written to a mode-0600 file outside the repo. Reports contain counts, timings and fixed error codes.

## Stress ramp

`stress-ramp` finds what breaks first. Its 8,000 users join in six stages: 1,000, 2,000, 3,000, 4,500, 6,000 and 8,000, four minutes apart, over 24 minutes. A profile's `ramp.stages` lists each stage's start and cumulative user count. With a ramp, persona `sessions` and `timing.secondaryUse` count sessions per `ramp.periodMs`, so each user keeps the same activity rate whenever they join. The top stage is about eight times the `users-1000` load.

The report adds `metrics.stages`, with the latencies, statuses, counts and failures recorded during each stage, and the run prints one line per stage. Driver queue limits grow by one step for every 1,000 users. The `generator.*` histograms record the driver's timer delay, event-loop busy percentage and in-flight HTTP requests. Use them to tell a saturated driver from a slow server. A stress run is expected to fail its pass criteria once something breaks. Raise the stack's connection, ticket, upgrade and auth limits for the test IP, or the proxy breaks first.

## Files

- `plan.mjs` turns a profile and seed into the plan. Client timings around a chat visit are named in its `CLIENT` table.
- `setup.mjs` registers accounts, creates chats and seeds history.
- `run.mjs` replays the plan, resolves references to earlier sends and checks the results.
- `device.mjs` is one signed-in client device: socket, selected chat, cached history and refreshes.
- `transport.mjs` holds HTTP, WebSocket and measurement helpers; `schedule.mjs` is the open-loop scheduler.

## Client flows

HTTP paths below are relative to `/api/v1`. Chat paths are relative to `/chats/{id}`. Authenticated requests use the session cookie and user/device headers. Writes carry the CSRF header and origin. The request timings leave room for client-side dwell and renewals, and the runner starts each planned action independently.

| Flow | Requests and frames |
| --- | --- |
| Open app | `GET /auth/session`, then `GET /chats?limit=100` and `POST /auth/ws-ticket` in parallel. Upgrade with the `messenger` and signed ticket subprotocols. Debounce the first `watch_sidebar` by 250 ms. |
| Browse sidebar | Renew `watch_sidebar` every 20–23 s with sorted visible chat IDs. Activity, preference, read, and message hints coalesce to `GET /chats/{id}`. Chat creation, history and membership hints refresh the directory. |
| Open chat | Leave the old selection with `unwatch_presence` and `unsubscribe`. Send prior `dismissed` if present, then `subscribe_many` with one selection and its SQL baseline and Redis cursor. Load `GET /messages?limit=50` or restore a saved around-anchor location. Load `GET /reads`, `GET /pins?limit=50` and `GET /visibility`, and watch presence for up to 100 members. Poll `GET /messages/changes?afterRevision={revision}&limit=100` after the initial snapshot and renew features every 12–15 s. Clear a marked-unread chat with `DELETE /unread-mark` on open. |
| Scroll or jump | Older history uses `GET /messages?beforeSeq={first}&limit=50`. The quote jump reveals a cached target locally or uses `GET /messages/around?messageId={id}&limit=50`. Restoring a saved position also supplies `anchorSequence`. |
| Send and reply | Send `send` with request ID, chat ID, body and optional `replyToMessageId`. Observe `queued` and await own `message_saved`. For live frames, `applied` acknowledges covered sequences and can carry the room cursor, while `received_message` releases a notification pending history coverage. A latest-page baseline can send `dismissed`. Uncertain sends use `POST /sends/status`. |
| Mark read | After a foreground dwell, `POST /reads` with `throughSequence` from a visible incoming message. Selected peers observing `reads_changed` refresh with `GET /reads`. Reader details use `GET /messages/{messageId}/reads?limit=50`. |
| Edit or delete messages | Edit with `PATCH /messages/{messageId}` and `{body,expectedVersion}`. Delete with `POST /deletions` and `{requestId,scope,target:"MESSAGES",messageIds}`. Scope is `SELF` or `EVERYONE`. Use `GET /visibility` and `POST /messages/resolve` in batches of at most 100 on revision changes, then reload the latest history. |
| Forward | Open the source chat, then send the message's text with `chatId`, `forwardFromChatId` and `forwardFromMessageId`. Select the destination after sending. |
| Pin a message | `PUT /pins/{messageId}` with `scope` of `SELF` for direct and `EVERYONE` for group, then `GET /pins?limit=50`. A `pins_changed` hint also refreshes the selected pins. |
| Sidebar preferences | `PUT /pin`, `PUT /mute` with `{durationSeconds:3600}`, and `PUT /unread-mark`. The preference hint refreshes the summary. |
| Lookup and start a direct chat | `GET /users?query={username}`. Draft selection is local. The first `send` uses `recipientId` in place of `chatId`. Refresh the directory and open the saved chat. |
| Create group and manage members | Look up the chosen users, `POST /chats/groups` with `{name,memberIds}`, refresh the directory and open the group. The member dialog uses `GET /chats/{id}` and `GET /members?limit=50` in parallel. Look up the addition, `POST /members` with `{memberIds}`, reload the dialog, then `DELETE /members/{userId}` and reload again. |
| Rare actions | Account and directory actions run one at a time, about a second apart, near the end of a session. |
| Sessions and sign-in | `GET /auth/sessions`, `POST /auth/logout` then close the socket. `POST /auth/login` with the same device ID, then start directory and socket work. |
| Background, reconnect, close | Background stops foreground reads. Foreground refresh checks session, directory, selected chat and pending sends. A blip closes the socket, then takes a fresh ticket and restores the selected subscription. Catch-up uses `GET /messages?afterSeq={baseline}&limit=50`, or latest history when detached, then refreshes feature state and pending sends. Close the socket at app close. |

The timed actions approximate browser viewports and human dwell. The sidebar has 14 visible rows, and the history window retains at most 150 messages. The fixture gives the latest seeded message a reply to an early row, so a quote jump can reach beyond the first page. A forward chooses a recent message in the source history window. Anchor restoration fetches the initial around page. A first subscription can receive `recovery_failed` if there is no Redis cursor or no retained history. The driver uses SQL catch-up in that case.

Group rows can arrive with an empty member list. The browser can attempt an immediate empty presence watch while it fetches group details, and the gateway rejects that frame as invalid. The driver loads the members before sending the watch.

The profiles cover the flows in the table. Deep links, password changes, session revocation, unpinning, pin reorder, unmute, full history clearing, chat deletion, and notification permissions are outside this workload.

## Limits and evidence

The default pacing is one register/login per second and four tickets per second per process. The API proxy defaults to 1 auth request/s with burst 10, and 5 tickets/s with burst 20. The login throttle keys attempts by username and IP, grants five free attempts and clears the record on successful login. The driver uses valid credentials and avoids retries on login and register. Set `--auth-rate` and `--ticket-rate` to stay within the rates actually configured on the stack.

For a dedicated load stack, the relevant environment settings are `MESSENGER_TICKET_IP_RATE`, `MESSENGER_TICKET_IP_BURST`, `MESSENGER_AUTH_IP_RATE`, `MESSENGER_AUTH_IP_BURST`, `MESSENGER_CONNECTION_LIMIT`, `MESSENGER_WS_UPGRADE_RATE`, and `MESSENGER_WS_UPGRADE_BURST`. The default connection limit is 200 per IP and the upgrade limit is 30/s with burst 100. Size connection capacity for peak concurrent devices across generators. On the benchmark stack, edit its external `bench.env` only if needed and recreate only the proxy whose environment changed.

The planner caps the workload at 10,000 accounts, 1,000,000 actions, 200,000 sends, 1,000 planned sends per second and one hour. Per 1,000 users, the runner limits concurrent actions to 512, HTTP operations and background work to 256 each, ticket waiters to 64, and auth waiters to 32. Frames and pending socket output are capped at 64 KiB, HTTP responses at 1 MiB. A failed action remains visible in the report. Scheduling lag compares the planned time against the start of the action handler. Earlier outstanding requests do not block unrelated actions. Data-dependent actions can wait for their specific send or page. Sends also record wire scheduling lag, which includes this wait. A lag above the profile's bound fails the run.

The report includes histogram counts, means, percentile bounds and maxima, plus HTTP statuses, action totals by persona and peak RSS. App-open latency ends at directory readiness, and chat-open latency ends at the first history page usable by the view. Recipient samples cover online direct devices and selected group devices. Delivery via catch-up gets its own bucket. Repeated notifications for the same message are counted separately from conflicting terminal results. Read propagation samples require a selected observer and a refreshed read frontier. Final HTTP resolve checks compare each saved message ID, body and sequence and check every mutation from the actor and one peer. This check measures durable visibility after the run. It doesn't verify physical purge completion or every offline device's local cache.

Server-free checks:

```sh
node --test tests/realistic-load/self-check.test.mjs
for file in tests/realistic-load/*.mjs; do node --check "$file"; done
```
