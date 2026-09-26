# WebSocket scaling research

The [project and article plan](plan.md) synthesizes the source reviews and primary documentation. [One-cluster architecture options](architecture-options.md) develops the load balancing, broker, recovery, and authorization choices with a Node.js routing example.

Start Messenger with the [architecture overview](messenger-architecture-overview.md), then read the [full architecture](messenger-architecture.md) and [detailed sequence and failure flows](messenger-detailed-flow.md). The [broker decision](../docs/adr/0001-messenger-broker-split.md) records why send commands use RabbitMQ quorum queues while saved events use Redis Pub/Sub plus short Stream history. [Messenger recovery source checks](messenger-recovery-sources.md) documents the primary-source guarantees.

The [Messenger broker research](messenger-broker-research.md) compares Kafka, RabbitMQ and Redis for user and group rooms. It preserves the alternatives and the earlier article reviews. The command-broker split is selected; live fanout capacity and recovery costs still need measurement.

| Source | Review |
| --- | --- |
| Taycode, distributed chat | [taycode.md](sources/taycode.md) |
| Lichess, separate socket server | [lichess.md](sources/lichess.md) |
| Avito, Go and Centrifugo | [avito.md](sources/avito.md) |
| Young Gao, distributed architecture | [young_gao.md](sources/young_gao.md) |
| WebSocket.org scale, Kubernetes and security guides | [websocket_org.md](sources/websocket_org.md) |
| Priyanshu Gupta, notifications | [priyanshu.md](sources/priyanshu.md) |
| Local Gemini video summary, audited against speaker's materials | [video.md](sources/video.md) |
| Brain Bytes & Binary, handshake and routing | [brainbytes.md](sources/brainbytes.md) |
| Follow-up: load balancing and Centrifugo room authorization | [routing_auth.md](sources/routing_auth.md) |

The requested Lichess blog URL currently returns a 404. Its review uses Lichess's own repositories and distinguishes present implementation from the missing article. The video note is based on a sub-agent's audit of `video.txt`; the main synthesis uses the audit and the speaker's published demo, not the local summary as a verified transcript.
