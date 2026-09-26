# Implementation review

Baseline: `fd35d6abecbe83d20c860a57aea96d4329137b8e`. Reviewed against CONTEXT.md, the accepted broker ADR, the Messenger architecture and detailed flow, and the agreed CODING_STANDARDS.md. Separate GPT-6 Sol reviewers assessed standards and specification coverage.

## Standards

The initial review found two defects and one design concern. Registration now creates the user and session in one SQL transaction, with a regression test that injects a session failure and retries the same username. Invalid broker payloads now move to a bounded durable quarantine queue after publisher confirmation; failed quarantine attempts preserve the original command. Permanent SQL validation errors record a durable rejection after rollback; transient database errors remain retryable. A regression test verifies that rejected writes do not consume a conversation sequence. Socket lifecycle and reconnect handling moved into a private connection hook, separate from message recovery and state.

## Spec

The initial review found missing poison-command handling, missing Redis replay during periodic position checks, and incomplete failure testing. Poison handling and periodic replay are implemented. A follow-up review found a race between a tail read and a newer live cursor; the check now snapshots its starting cursor and does not overwrite one advanced by live traffic. A regression test appends a final Stream event without publishing it and observes its eventual replay through the still-open WebSocket.

The integration suite covers cross-node messaging, multiple sender devices, duplicate sends, contiguous SQL history, offline catch-up, membership removal, and outbox retry. The local cluster check verifies three API gateway replicas and three WS gateway replicas. Its failure drill stops an API replica and a recipient WS replica, checks continued messaging and recovery on surviving replicas, and restores the stopped containers.

The local stack has one RabbitMQ node and one Redis node. Replicated broker failover, sustained load capacity, and production retention operations remain unverified. The architecture's billion-user database alternatives are research, not this deployment's capacity claim.

Initial findings: Standards 3, Spec 3. The code defects and module concern were addressed. The remaining Spec limitation is replicated broker failover and capacity validation.

Final local checks: 20 tests passed across seven files; strict typechecking, Vite production build, Prettier, Docker image builds, and the six-replica acceptance check passed. Desktop browser sends and a 390px iframe viewport were checked with the shared preview.
