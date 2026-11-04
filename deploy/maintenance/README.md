# Retire retained message content

The scoped-deletion upgrade replaces retained outbox bodies with references and Redis replay bodies with recovery hints. Perform this once while upgrading an existing deployment. Fresh databases have no old replay content. V8 rejects body-bearing new outbox writes at the database seam; the Redis script also rejects body-bearing replay data. Its unvalidated upgrade constraint permits old rows until this retirement step converts them.

Stop the project's API, gateway, command processors and outbox publishers, leaving PostgreSQL and Redis running. Run `bash deploy/maintenance/retire-message-content.sh <compose-project>`, then start all application services on the new version. The script refuses to run while those services are active. It converts at most 1000 outbox rows per transaction, resets old publisher leases and retires each room's replay stream, epoch and byte counter. Existing clients fall back to authoritative SQL recovery.

Use only the intended project name. The local deployment uses `messenger-browser`. The script expects the repository's PostgreSQL database and service names. Its row count reports completed conversion; it does not erase Rabbit commands, backups, WAL, browser memory or packets. Keep old application processes stopped so they cannot recreate body-bearing retained events. Complete retirement before exposing deletion or reporting application-store purge completion.

V9 schedules durable purge for chats that were already globally closed under the earlier soft-deletion implementation. It updates chat metadata and creates coalesced jobs; the existing bounded worker removes the historical message rows. Repeating deletion on a closed chat also repairs missing unfinished work without scanning its history.

SQL history deletion denies the accepted prefix immediately, then removes rows through durable bounded purge jobs. Track oldest pending job age, batch failures and progress until physical completion. Bodyless send-request results stay retained to prevent retry resurrection.

V7 backfills retained mutation metadata and deletes legacy tombstones synchronously. Check those legacy row counts before upgrading a large existing database and schedule that migration separately. This project currently has no production deployment. The bounded workers apply to newly accepted history deletion, not an unbounded promise about old schema conversion.

The deletion status deletedRows value is purge work committed since that operation was accepted. Overlapping later clears can contribute to it. Completion is established by the purged sequence cutoff, not by treating this count as the exact cardinality of the original prefix.
