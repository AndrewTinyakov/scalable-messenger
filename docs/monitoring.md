# Monitoring the Messenger stack

The local Compose stack provisions Prometheus, Grafana, Alertmanager, and exporters for PostgreSQL, Redis, RabbitMQ, and all three NGINX hops. Prometheus scrapes each API and WS instance directly. Docker DNS discovers both command processor and both outbox publisher replicas. The API and Kotlin worker metrics endpoints require HTTP Basic authentication; the WS and exporter endpoints stay on the Compose network.

Open [Grafana](http://localhost:3000/d/messenger-overview/messenger-overview) with local credentials `admin` / `admin`. The provisioned dashboards are **Messenger overview**, **Messenger WebSocket**, and **Messenger backend and infrastructure**. [Prometheus](http://localhost:9090/targets) shows scrape health, and [Alertmanager](http://localhost:9093) shows firing alerts. Local ports default to 3000, 9090, and 9093. Override them with `GRAFANA_PORT`, `PROMETHEUS_PORT`, and `ALERTMANAGER_PORT` before `scripts/dev-up.sh`.

Run `npm run monitoring:check` to verify the expected replica count, scrape health, provisioned dashboards, and every dashboard query. The check uses `GRAFANA_ADMIN_PASSWORD` when it is set. Run `npm run monitoring:dashboards` after changing panel definitions. Prometheus rules live in `deploy/prometheus/alerts.yaml`. Check the configuration with `docker run --rm --entrypoint promtool -v "$PWD/deploy/prometheus:/etc/prometheus:ro" prom/prometheus:v3.14.0 check config /etc/prometheus/prometheus.yaml`; replace `check config /etc/prometheus/prometheus.yaml` with `test rules /etc/prometheus/alerts.test.yaml` to run the alert cases.

## What to watch

| Area | Main signals | Meaning |
| --- | --- | --- |
| API | HTTP request rate, 5xx rate, p95 latency, JVM heap, Hikari connections | User-facing HTTP health and database pool pressure. |
| WebSocket | Connections per node, proxy active connections, handshake and error results, queue bytes, slow closes | Socket capacity, failed operations, and clients falling behind. |
| Group access | gRPC authorization rate, denials, p95 latency, expired renewal leases | Subscribe and renewal dependency on the API. |
| Live delivery | Local fanout recipients and p95 duration, saved-event lag, Rabbit confirm p95 | Hot-room work and SQL-save-to-WS delivery time. Saved-event lag ends at the WS node, before browser delivery. |
| Recovery | Redis replay results, SQL fallback, recovery-required closes, stale rooms, oldest room position age, sweep duration | Missed Pub/Sub events and whether quiet-room checks keep pace. |
| Commands | Queue depth and consumers per partition, unacknowledged deliveries, command retries, saved/rejected/duplicate results, queue arrival and processing p95 | Whether accepted sends reach a durable result. |
| Outbox | Pending rows, oldest row age, claims, Redis publication failures, batch p95 | Whether SQL events move to Redis promptly. Both publisher replicas sample the same table; use `max`, not `sum`, for pending and age. |
| Dependencies | RabbitMQ resource alarms and cluster peers, Redis node and slot state, PostgreSQL connections/deadlocks | Resource pressure and cluster health. |

The outbox backlog sampler reads the pending-row index every 15 seconds in each publisher. Its `messenger_outbox_backlog_sample_healthy` gauge becomes zero on a failed query, so an old backlog value is visible as stale rather than silently trusted. The RabbitMQ detailed queue scrape selects only the five Messenger queues; dashboards take `max by (queue)` because a queue can appear on more than one broker scrape. Redis and PostgreSQL exporters report infrastructure state independently of app health.

Command queue delay compares the WS producer timestamp with the processor clock. Saved-event lag compares the SQL creation timestamp with the WS clock. Keep host clocks synchronized when interpreting those two latency charts.

Alerts cover missing or down replicas, API errors, slow socket clients, delayed room checks, recovery spikes, command retries and backlog, dead letters, old outbox events, Redis and RabbitMQ cluster trouble, and PostgreSQL connection pressure. Thresholds in `alerts.yaml` are starting points for this local workload. Alertmanager stores and groups alerts here but has no external notification receiver; add a receiver and real credentials for a deployment that must page someone. Prometheus retains seven days of local data in a named volume.

The Compose credentials are local examples. Set `GRAFANA_ADMIN_PASSWORD` before the first Grafana start for a different admin password, and replace the API/worker monitoring credentials and corresponding Prometheus Basic Auth configuration together when deploying elsewhere. No application or exporter metrics port is published to the host; only the three monitoring UIs bind to loopback.

Sources for exporter endpoints: [RabbitMQ Prometheus](https://www.rabbitmq.com/docs/prometheus), [Redis exporter](https://github.com/oliver006/redis_exporter), [PostgreSQL exporter](https://github.com/prometheus-community/postgres_exporter), and [NGINX exporter](https://github.com/nginx/nginx-prometheus-exporter).
