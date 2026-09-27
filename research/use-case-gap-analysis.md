# Which projects add a new WebSocket problem?

The current set is Messenger, Kanban desks, and Twitch-like chats: many streamer rooms with a skewed audience, including some very large rooms. This note compares the eight use-case cards on [Centrifugo's home page](https://centrifugal.dev/) with that set. The cards name applications, not eight different routing designs. Centrifugo supports WebSocket, SSE, and other transports for the same channel model, so an application appearing on its site does not by itself make WebSocket the right transport. [Centrifugo introduction](https://centrifugal.dev/docs/getting-started/introduction).

## The useful distinction

Ask four questions before adding a project:

1. Does the client need to send commands over the live connection, or only receive updates?
2. Is the client interested in one stable object, many stable objects, or a changing set of objects?
3. Must it receive every event, or only the newest state?
4. Must the server reach one specific connected client, or all listeners of a channel?

The three selected projects already cover arbitrary overlapping chats, one bounded object room on one WS node, and many streamer rooms whose audiences range from one WS node to many. A new project earns its place when an answer above changes routing, state recovery, or connection management. This is an architectural judgment, not a claim made by Centrifugo.

## The eight Centrifugo categories

| Site category | Difference from selected projects | Recommendation |
| --- | --- | --- |
| Chat & Messaging | Messenger and Twitch-like streamer chats cover it. Live comments often use the same room pattern with fewer publishers. | Covered. |
| Live Dashboards | Often one-way and latest-value. A dashboard may watch many metrics, but the routing resembles a market watchlist. [SSE is a one-way transport](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events). | Use as a small example in the market-data project; do not add a separate dashboard unless the data source cannot push. |
| Multiplayer Games | A small match whose players fit on one WS node has Kanban's placement pattern. The new work is authoritative state, update cadence, and ephemeral positions. A world where players move across spatial cells *does* add changing, overlapping listener sets. Centrifugo's map model treats cursors and lobby state as keyed state, unlike a chat event stream. [Map subscriptions](https://centrifugal.dev/docs/server/map_subscriptions). | A bounded Pong or tic-tac-toe game is an illustration inside Kanban. Consider a moving world only if spatial interest management is a teaching goal. |
| State Sync | Kanban already needs snapshot plus updates and protection against a snapshot/subscription race. Keyed ephemeral state such as cursors, presence, or a scoreboard adds different recovery rules, but not necessarily different WS node placement. Centrifugo distinguishes event streams from map subscriptions with a full state sync on join. [Map subscriptions](https://centrifugal.dev/docs/server/map_subscriptions), [stream history and recovery](https://centrifugal.dev/docs/server/history_and_recovery). | Add cursors and a versioned snapshot to Kanban; avoid a separate state-sync app unless the course covers synchronization itself. |
| Financial Data | A watchlist subscribes to many symbols; one symbol may have many listeners. Prices can update faster than clients can draw them. For price *snapshots*, the newest value can replace intermediate values; trades and orders cannot be silently dropped. Centrifugo documents cache recovery for latest-value channels and latest-only batch flushing for complete-state messages. [History and recovery](https://centrifugal.dev/docs/server/history_and_recovery), [message batching](https://centrifugal.dev/docs/pro/client_message_batching). | Strong fourth project if the aim includes hot many-to-many fanout, backpressure, and latest-state semantics. Keep financial *trading* out of scope. |
| Live Data Feeds | This can be the same design as financial data or a dashboard. If a legacy source only supports reads, shared polling changes the backend side: each WS node polls a key once for its local listeners, rather than each client polling separately; this design has no cross-node Pub/Sub for the polled keys. Centrifugo marks shared poll experimental. [Shared poll design](https://centrifugal.dev/blog/2026/05/21/shared-poll-subscriptions). | Make shared polling an optional variant of the market/watchlist project, not a project merely called "live feed." |
| IoT & Tracking | Periodic device uploads can use HTTP POST. A live moving map is different on the *viewer* side: each client watches a viewport, so its set of geographic cells changes as the map moves. Centrifugo has a first-party drone demo with viewport-specific delivery. [Centrifugo demos](https://centrifugal.dev/). | Strong alternative fourth project: moving-map viewers plus HTTP device updates. |
| AI Streaming | One user receives one model response. SSE plus an HTTP request is often sufficient; even Centrifugo recommends direct SSE for a single user and generation. Multi-viewer generation and resuming missed tokens introduce a channel and history, but resemble existing fanout/recovery problems. A per-client gRPC subscription stream is a different backend path, yet its channel history is not useful by default. [AI apps guide](https://centrifugal.dev/docs/getting-started/ai_apps), [proxy subscription streams](https://centrifugal.dev/docs/server/proxy_streams). | Do not add for WS scaling. Use it as a transport-choice sidebar. |

## Two worthwhile extra projects

### Live moving map

Simulate vehicles that report positions to the API by HTTP POST. A client opens a map and uses one WS connection to watch geographic cells near its viewport. Panning or zooming changes its subscriptions without moving its socket. A vehicle crossing a cell boundary changes its recipient set. A viewer near a boundary watches several cells, so no single placement key can put all related sockets on one WS node. This tests interest updates, duplicate suppression at cell boundaries, and the cost of rapid subscribe/unsubscribe. The Centrifugo [drone demo](https://centrifugal.dev/) and its [shared-poll account](https://centrifugal.dev/blog/2026/05/21/shared-poll-subscriptions) use cell-based tracking. A one-way SSE connection with separate HTTP control requests is possible, but WS makes frequent subscription changes on one connection straightforward. This is an inference from the transport properties, not a requirement of the map.

This teaches something beyond Messenger: the set of recipients changes with *position and time*, even while each client remains connected to the same WS node. Keep the visual app tiny: moving dots, a viewport, and a subscription counter.

### Market watchlist or live sports scores

Clients watch several symbols or matches at once; popular ones attract many clients. Producers send updates to the API or a feed adapter, which publishes once per key. WS nodes deliver only watched keys. Most price or score *snapshots* are replaceable: when a client falls behind, send the newest value instead of a backlog of obsolete values. On reconnect, send the latest snapshot per key, then newer versions. Centrifugo documents cache recovery for latest-value channels and a distinct stream recovery mode for events where every item matters. [History and recovery](https://centrifugal.dev/docs/server/history_and_recovery). Use synthetic prices or sports scores so the project does not depend on a real financial feed.

The connection can use ordinary capacity-based placement, as in Messenger. The new lesson is **delivery semantics under load**, not a new L4/L7 choice. If the article's main aim is routing, the moving map is more distinct. If it aims to show why message type changes scaling, this project is valuable.

## One option outside the site cards

A **remote-command agent fleet** would keep many mostly idle agents connected. The API must send a command to one specific agent, then receive an acknowledgement or timeout. That favors an expiring `agent ID -> WS node` location record and direct node delivery instead of a broker subscription for every room. A crashed WS node leaves stale location records, so the command path needs retry and offline handling. Periodic telemetry remains HTTP POST; the live connection exists because the API initiates commands. This is a proposed design, not a Centrifugo feature claim. It adds a truly different routing target but makes connection liveness and offline semantics the main lesson.

## Suggested set

Keep Messenger, Kanban, and Twitch-like chats with many streamer rooms. Add **live moving map** if one more project should teach a distinct recipient graph. Add **synthetic market watchlist** if there is room for a fifth project about latest-state delivery and slow clients. Treat a simple game, a dashboard, and AI output as compact examples inside those projects or in the transport-choice discussion. Add the agent fleet only if direct server-to-one-connected-client routing deserves a full chapter.

The source facts above are from first-party Centrifugo documentation, its own demos, and MDN's transport documentation. Project rankings and proposed routing are my inferences from those facts.
