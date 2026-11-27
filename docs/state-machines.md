# Application state machines

This audit covers production client and server code at the PR #6 base, `73abbf4`. Lifecycle modes are named where callers previously had to infer them from combinations of flags, nullable resources, timestamps or strings. Wire schemas, database rows and broker guarantees retain their existing formats.

## Go gateway

### Explicit lifecycle changes

| Owner | Previous representation | Explicit states and transitions |
| --- | --- | --- |
| Socket server | `closing` and `draining` booleans | Accepting → draining → closing, or accepting → closing. Drain never moves a closing server back to draining. Admission and readiness require accepting. |
| Connection, ACK tracker, sidebar coordinator | Separate `closed` booleans | Active → closed. Existing mutexes and `sync.Once` retain their ownership and synchronization duties. |
| Per-connection command worker | `commandRunning` and `commandScheduled` booleans | Idle → queued → running → queued or idle. Running still counts toward per-connection admission capacity. |
| Group authorization grant | `authorized` and `missed` booleans | Authorizing, authorizing with missed frames, authorized, authorized with missed frames. Authorization retains the missed-frame fact for SQL recovery notification. |
| HTTP upgrade reservation | `reserved` boolean | Unreserved → reserved → released. Activation and deferred cleanup each release at their existing ownership boundary. |
| Handshake connection admission | `handshakeAdmissionState` | Unowned → owned → transferred, or owned → unowned during failed-handshake cleanup. |
| ACK deadline timer | Nil timer and zero armed deadline | Unused → armed → stopped, with stopped → armed and armed deadline replacement. Timer resource allocation is independent of armed/stopped status. |
| Ping cadence | `pingSteady` boolean | Jittered first tick → steady interval. |
| Room registry and local room | `closed` and `retired` booleans | Registry open → closed; local room active → retired. |
| Room membership | Independent atomic `catching` and `left` booleans | Catching up ↔ live; either → left. Compare-and-swap transitions prevent a finishing replay or a renewed catch-up barrier from restoring a departed member. |
| Redis subscription hub | `closed` boolean | Open → closed. |
| Redis shared subscription group | `started` and `closed` booleans | Idle → reading → closed, or idle → closed on failure. |
| Redis listener | `readyClosed` boolean and terminal error nil sentinel | Subscribing → ready → stopped, or subscribing → stopped. Ready and terminal errors retain their separate result payloads. |
| Rabbit publisher | `closed` boolean | Open → closed. |
| Rabbit publishing worker | Nil channel slot | Disconnected → connected → disconnected. Channel resources and transport cancellation follow the same acquisition/release points. |
| Rabbit outstanding publish | Nil `rejected` error | Pending confirmation → returned. The rejection error is the result payload; broker confirmation still resolves or overrides it exactly as before. |
| Handshake instrumentation | `finished` boolean and empty stage string | Active stage → completed stage → active next stage; either → finished setup. Stage labels remain unchanged. |

### Already explicit or intentionally retained

- Rabbit publish requests already have queued, publishing and cancelled states with atomic compare-and-swap transitions.
- Protocol event kinds, command kinds, error codes, handshake stages and monitoring outcome types already name their variants. Generated contract files were not edited.
- Subscribe/reconnect retries and the socket reader/writer loops already express control flow in ordered operations, loops and `select` statements. Retry counts and backoff durations are measurements, not hidden state combinations.
- Context cancellation, channel closure, wait groups and `sync.Once` already express cancellation, notification, joining and one-time cleanup. They remain synchronization mechanisms alongside explicit state values.
- Subscription maps and pointer identity identify current memberships and grant generations. Sidebar watch generations and expiration timestamps protect against stale asynchronous work; presence uses per-user versions and per-bucket sequences. These retain their existing identity and time checks; an enum would not replace those facts.
- ACK pending entries, applied/dismissed baselines, message sequence heaps, room epochs and Redis Stream IDs are ordered recovery data. They are not mutually exclusive lifecycle modes.
- Redis connection counts and presence state are written by their owning gateway as absolute values; a dead gateway's entries are removed through the gateway registry. See ADR 0005.
- Nil optional dependencies and resource pointers, boolean authorization/result values, immutable Redis-client ownership, set membership, and wire flags describe capabilities, results or data rather than evolving lifecycle modes.

### Gateway ordering and lock ownership

Each handshake reserves node capacity before the HTTP upgrade so simultaneous upgrades count toward the limit. It joins the user room before validating the session against the API. A racing logout can then be observed as a room event or rejected by session validation. The connection mutex guards its presence state, and the randomized first ping spreads new connections across one interval before the ticker returns to its regular cadence.

The ACK tracker counts message frames offered to the socket writer, separately from Redis Stream positions. A receipt resolves one live notification. An applied acknowledgement records device application, and a dismissal resolves the skipped interval. Its cursor limit bounds allocations for client-supplied chat IDs.

The Redis subscription hub owns the primary groups and slot cache. A channel uses the primary for the CRC16/XMODEM hash of its room name, modulo 16,384. The hub releases its mutex before entering a group. The group may take the hub mutex while holding its own. The group mutex guards the listeners, their queues and results, pending unsubscriptions and expected acknowledgements. Closing the readiness or completion channel publishes its result. An unsolicited unsubscribe invalidates the slot cache and retires the listener. Unsubscribe failure rebuilds the shared feed, and a reconnect also invalidates cached slot owners. Rejoining a closed group waits for its removal from the hub.

After a room feed reconnects, the gateway compares the position from the new live subscription to the last known position. It replays publications made during the outage or requests a fresh SQL recovery. Adopting the new tail alone would hide that gap.

The room and presence Redis adapters return a nil interface when listener creation fails. A nil concrete listener pointer boxed into an interface would compare unequal to nil.

## Kotlin services

### Explicit lifecycle changes

| Owner | Previous representation | Explicit states and transitions |
| --- | --- | --- |
| `OutboxPublicationWorker` | `running` boolean plus nullable thread | `Stopped -> Running(thread) -> Stopping(thread) -> Stopped`. The worker owns its thread until its run exits. Readiness events cannot start duplicate workers. A stop that times out retains `Stopping` and blocks replacement. Startup failure restores `Stopped`. |
| `GrpcServerLifecycle` | Nullable server, including during shutdown | `Stopped -> Running(server) -> Stopping(server) -> Stopped`. Start and stop serialize. Termination failure keeps the owned server in `Stopping`; `isRunning` reports only `Running`. A later stop retries termination. |
| `DatabaseTransactionListener` | Independent nullable active/completion timestamps and nullable completion phase string | `Beginning -> Active(started) -> Completing(COMMIT or ROLLBACK, started)`, then removal on terminal callback. Begin failure removes the observation directly. A completion phase always carries its matching timestamp. Existing metric names and labels remain intact. |
| `MessageSendMetrics.TransactionWindow` | Nullable lock/callback timestamps plus `observed` boolean | `Executing(optional lock) -> CallbackFinished(optional lock, finished) -> Observed`, with direct `Executing -> Observed` for failed begin or missing callback. Terminal observations discard timing payloads and repeated completion cannot record twice. |

### Already explicit

- `SendResultStatus` is `SAVED` or `REJECTED`. `SendResult` validates message/sequence/rejection payload combinations. `SendLookupStatus` also represents `UNKNOWN` on HTTP reads.
- `SendDecision` separates repeated, rejected, and accepted requests before SQL writes. `SendTarget` separates existing chats and direct pairs.
- `SendTransactionCompletion` maps Spring's committed, rolled back, and unknown completion codes to typed outcomes. Command processing, acknowledgements, outbox batch/publication stages, and mutation kinds also have enums.
- `DeletionState` distinguishes accepted deletion from completed physical purge. The repository derives the state from authoritative purge progress, rather than maintaining another application flag.
- `MuteEnd` separates forever and timed mute commands. `ChatPreferences` checks that a permanent mute has no end time.

### Retained independent facts and persistence transitions

- The query observer's statement timer, fetch timer, and sticky failure flag are independent observations. They can close separately, and batches can execute multiple statements. Combining them into one exclusive lifecycle would change metric behavior.
- `MessageSendService`'s synchronization registration boolean only chooses fallback metric cleanup if transaction registration did not run. It is a local ownership flag, with no independent stored lifecycle. Batch callback timestamps are local duration measurements.
- Session existence and expiry, chat membership, message deletion/version snapshots, and hidden-history intervals are authoritative SQL facts. Repository reads apply authorization and visibility predicates; transactional repository methods perform their durable transitions. They are not mutable Kotlin lifecycle objects.
- Outbox lease ownership, expiry, retries, and completion are guarded SQL claim/complete operations. A claimed `OutboxMessage` is a publication snapshot, not the authoritative lease record. The refactor keeps the claim transaction and publication retry guarantees.
- Purge and visibility-cleanup jobs progress through SQL cursors and job-row removal. `Int?` batch results distinguish no available job from a batch's removed-row count. They do not carry a multi-step local lifecycle.
- Read watermarks, recovery coverage, pin ranks, mute expiry, unread marks, directory pagination flags, and bounded-loop counters remain independent domain values. Binary status snapshots do not acquire enums solely to rename true and false.
- Metric outcome locals already use named enums. JFR's mutable event fields belong to the JFR event API, rather than an application lifecycle.


## Browser client

### Explicit lifecycle changes

| Module | Machine and transitions | Invariant made explicit |
| --- | --- | --- |
| `client/src/shared/api/socketConnection.ts` | Idle/offline -> ticket -> handshake -> connected; failure -> waiting -> ticket; terminal revoked/disposed. | Each state owns its controller, socket, or timer. Superseded ticket/socket callbacks cannot mutate the current attempt. Connecting, revoked, disposed, and retry timers cannot coexist. |
| `client/src/entities/message/historyRequests.ts` | Pending -> overflowed/cancelled/completed. | Only pending requests retain mutation overlays. Cancelled and overflowed requests cannot share flags or retain overlay buffers. |
| `client/src/features/conversation/mutationRecovery.ts` | Unselected -> awaiting snapshot -> ready -> refreshing -> ready; selection replaces the current state. | A refresh requires a selected chat and known revision. The promise and revision belong to that refresh; stale completion cannot overwrite another selection. |
| `client/src/entities/message/sendRequests.ts` | Dispatch idle -> throttled -> awaiting result -> idle. Reconciliation ready -> polling -> ready/backoff -> polling. | Dispatch cannot simultaneously own a pacing timer and an active request. Poll backoff owns its deadline and failure count; concurrent polls remain coalesced. |
| `client/src/entities/message/model.ts` | Explicit allowed send-state transition table. | Saved and rejected remain terminal; queued cannot regress; sending and retryable may transition between each other. Existing stored and wire values are preserved. |
| `client/src/entities/message/chatRecovery.ts` | Retry scheduled -> retrying, or cancellation. Synchronization refreshing -> invalidated -> refreshing. | Only a scheduled retry owns a timer. Retry attempt count survives timer execution. A synchronization pass verifies a changed history revision only after all retained batches and the latest page have reconciled. If requests are skipped or fenced by newer revisions, synchronization makes up to three passes and leaves any incomplete revision for the next hint. |
| `client/src/features/message-pins/useMessagePins.ts` | Idle -> refreshing -> invalidated -> refreshing -> idle. | Idle cannot retain rerun intent or a running promise. Completion releases only its own refresh, including after a chat switch. |
| `client/src/app/useMessengerSocket.ts` | Idle -> scheduled -> refreshing -> idle/scheduled; cleanup -> closed. | The scheduled state owns the timer. Closed is terminal and asynchronous refresh completion cannot schedule more work after cleanup. |
| `client/src/app/useChatDirectory.ts` | Absent request -> refreshing -> invalidated -> refreshing -> absent request. | Serial directory refresh and full-refresh escalation remain unchanged from PR6. The operation names its pending rerun explicitly. |
| `client/src/features/conversation/useConversationFeatures.ts` | Read-summary idle -> refreshing -> invalidated -> refreshing/idle. Read-write idle -> sending -> waiting -> sending/idle. | Summary rerun intent requires an active refresh. A read writer cannot both send and own a delay timer; cleanup invalidates the current chat scope. |
| `client/src/app/App.tsx` | Restoring, anonymous, authenticated, failed. | Restore errors are attached to failed restoration. A retained session is explicit during reconnect and failed refresh. Existing request revision checks and sign-out race handling remain intact. |
| `client/src/widgets/chat-panel/useMessageViewport.ts` | Settled -> pending restoration -> anchored/settled; intentional input, reveal, latest, or pagination settles restoration. | Pending saved-location restoration and a restored resize anchor cannot coexist. A pending restoration owns its location; an anchored restoration owns its message ID and pixel offset. |

### Already explicit or intentionally retained

- `SendState`, connection display state, parsed navigation targets, presence values, deletion scopes, pin scopes, chat kind, and notification choices are typed states already. The send transition rules are now an explicit table; their public values are unchanged.
- `HistoryVisibility`, `RecoveryState`, reading locations, latest/resolved/dismissed SQL sequences, mutation/visibility revisions, Redis cursors, and history bounds are independent facts and monotonic progress data. They are not alternative phases of one machine. Their existing feature methods retain the transitions and reconciliation rules.
- Chat selection, direct draft selection, online observation, page visibility, selected-chat membership/removal, and history-reading intent can legitimately vary independently. Combining them into a product state enum would add combinations without eliminating invalid states.
- Navigation promises, focus requests, paging/catch-up maps, per-message mutation sets, and optional subscriptions already encode one owned operation/resource at their existing boundary. Epoch/revision counters remain stale-result fences rather than artificial phases.
- `WatchPacer`, `PresenceStore`, recovery batching, notification throttles, automatic paging cooldowns and debounce timers have a single scheduling owner plus independent queued data. No competing lifecycle flags were found to combine.
- Dialog/form busy/error states, selection menus, reveal flags, drafts, member search, readers/pins paging flags, clipboard feedback, sound settings, and pointer movement flags are ordinary local UI facts or one request's status. They were inspected and left within their existing components. No rendered behavior or styling was changed.
- Generated HTTP and socket vocabulary are protocol sources of truth and were not edited.
