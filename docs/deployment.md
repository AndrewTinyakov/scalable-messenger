# Deploying Messenger

Use Docker Compose v2.24.4 or later for the production override's `!reset` port removal. A TLS load balancer terminates HTTPS and forwards HTTP to the `client` nginx container. The same client image accepts deployment URLs at startup, without rebuilding JavaScript.

## Public entry point

The load balancer needs one route for the exact browser origin, for example `https://chat.example.com`.

| Public path | Route inside Compose |
| --- | --- |
| `/`, `/assets/*`, `/runtime-config.js` | client nginx |
| `/api/v1/*` | client nginx → api-proxy → api-1 or api-2 |
| `/ws` | client nginx → ws-proxy → a WS replica |
| `/healthz` | client nginx, HTTP 200 for LB liveness |

Preserve the original Host header and support WebSocket upgrades. Set the LB idle timeout above nginx's 75-second socket timeout. Redirect port 80 to HTTPS on port 443 at the TLS terminator. `/healthz` checks nginx, not downstream readiness. Compose checks gateway `/readyz`; use private `/api/actuator/health` for API readiness. Actuator and stub-status routes must never be LB routes.

Set these values in the deployment's protected environment file:

```dotenv
MESSENGER_CLIENT_ORIGIN=https://chat.example.com
MESSENGER_API_BASE_URL=https://chat.example.com/api
MESSENGER_WS_URL=wss://chat.example.com/ws
MESSENGER_TRUSTED_PROXY_CIDRS=192.0.2.0/24 2001:db8:1234::/64
MESSENGER_BIND_ADDRESS=10.0.1.20
```

Replace the example CIDRs with the actual source addresses nginx sees from the LB. The values are space-separated IP CIDRs. Trust only LB addresses, never all addresses or an entire shared VPC. If the LB reaches a published port through host NAT, verify the source address observed inside nginx before choosing the CIDR. Reserve a dedicated LB source if NAT collapses trusted and untrusted traffic into the same peer.

Firewall the published nginx port so only the LB and private health check sources can reach it. Docker's published-port rules can bypass host firewall frontends such as UFW. Enforce the rule in the cloud firewall or Docker forwarding chain as appropriate. `MESSENGER_BIND_ADDRESS` defaults to `127.0.0.1`; select a private host address for a remote LB. Never publish Postgres, Redis, RabbitMQ, actuator, exporters or gRPC.

Nginx uses recursive real-IP processing only for configured trusted peers. It replaces forwarded address, host, port and scheme headers before proxying, and removes `Forwarded`. Rate and connection limits use the resulting real client IP. An untrusted peer cannot choose its limiter key using X-Forwarded-For. The LB must append the actual source IP to X-Forwarded-For or replace that header. The internal API and WS proxies also trust the front nginx's reserved edge address. Spring's native forwarded-header processing trusts only the reserved API-proxy app address, `10.246.0.10` by default, rather than arbitrary app or private CIDRs.

`MESSENGER_PUBLIC_SCHEME` is explicit and defaults to `http` in base Compose. The production override fixes it to `https` on all three nginx services, forwards HTTPS to the API and sends `Strict-Transport-Security: max-age=31536000`. It fixes the API's Secure cookie setting to true and removes the development API/WS published ports. Client startup rejects HTTP, WS, mixed HTTPS/WS, path-bearing browser origins and origins inconsistent with the single public route.

```sh
docker compose --env-file /secure/messenger.env \
  -f compose.yaml -f compose.production.yaml config --quiet
docker compose --env-file /secure/messenger.env \
  -f compose.yaml -f compose.production.yaml up --build -d
```

The application and client reject invalid origin configuration at startup. `compose config` checks interpolation and structure; it does not establish LB reachability or validate certificate termination.

## Credentials and first initialization

For development, `scripts/dev-up.sh` requires Node.js 24.15 or later, Go, OpenSSL and Docker Compose. On first run `scripts/prepare-dev-env.mjs` generates independent 32-byte random hexadecimal credentials for Postgres admin, migrator, API, command processor, outbox publisher and exporter, Redis, RabbitMQ, the Erlang cluster cookie, metrics, Grafana and WS tickets. It appends missing settings to the ignored `.env` file, preserves existing values and sets mode `0600`. Development sets `MESSENGER_SESSION_COOKIE_SECURE=false` for local HTTP. Base Compose's fallback remains true.

The launcher mirrors the metrics password into ignored `.local/secrets/metrics-password` with mode `0640`. Prometheus mounts that file read-only and joins the host service-credential group through `MESSENGER_GRPC_GID`. The containing directory has mode `0750`. Existing gRPC material stays in ignored `.local/grpc`. `scripts/dev-up.sh --prepare-only` prepares local credentials without starting containers. Do not use the development certificate authority for production.

For production, supply every required `${VAR:?}` credential through a protected environment file or a secret manager. Use independently generated URL-safe passwords, since the RabbitMQ and Redis URLs contain passwords. Keep `METRICS_USERNAME=metrics` and the `METRICS_PASSWORD` environment variable names. Supply a matching metrics password file using `MESSENGER_METRICS_PASSWORD_FILE`, readable by Prometheus's extra credential group. Provision the existing per-service gRPC certificate mounts and group with deployment-specific certificates. Do not put secrets in Docker image layers or tracked files. Container administrators can inspect environment-based secrets; restrict Docker access.

Postgres initializes only fresh database volumes. `postgres` is the admin and observability installer; application containers never receive that password. Each Kotlin service uses its own non-superuser login through the `messenger_runtime` group. That group has table CRUD and sequence access, without schema creation or role administration. The separate `messenger_migrator` role owns the database and schema and creates objects through Flyway. Default privileges give runtime logins access to new public tables and sequences. The exporter receives `pg_monitor` and access to the observability schema, rather than application write privileges.

Flyway currently runs at each service's startup, so those containers also receive the non-superuser migrator credential. Separating migrations into a release job would remove that credential from long-lived services and is a further deployment choice. Runtime privileges are shared across public application tables; these service logins distinguish credentials and connections, rather than enforce table-level service ownership.

Redis requires a password for clients and replication. The cluster initializer, Kotlin publisher, Go gateway's topology and sharded Pub/Sub connections, and Redis exporter authenticate. To connect the Go gateway to an externally TLS-enabled cluster, set `REDIS_URL=rediss://username:password@seed.example:6379/0` alongside `REDIS_CLUSTER_NODES`. Every cluster connection validates its target certificate using system trust and the individual node hostname. The bundled private Compose Redis cluster uses authenticated plaintext; provisioning Redis TLS certificates and listeners is separate.

RabbitMQ uses a random user password and Erlang cookie. Its management UI and cluster ports remain private. Grafana requires an admin password with no fallback. A persistent Grafana database retains its existing admin password; changing the environment alone does not rotate it.

Existing Postgres/RabbitMQ/Redis volumes do not automatically rotate credentials or create new Postgres roles. Back up data and apply the equivalent role/credential changes in a maintenance window before switching an existing deployment. Never delete persistent volumes to perform a production upgrade. For disposable development data, create a fresh Compose project and network ranges. Preserve the generated environment file across restarts.

## Network and host isolation

Only `edge` permits external routing. `app`, `data`, `monitoring` and the existing `grpc` network are internal.

| Service | Networks |
| --- | --- |
| client | edge |
| api-proxy, ws-proxy | edge, app |
| api-1, api-2, ws replicas | app, data, monitoring, grpc |
| command processor, outbox publisher | data, monitoring |
| postgres, pgbouncer, postgres-observability-init | data |
| rabbitmq-1/2/3 | data, monitoring |
| rabbitmq-cluster-init, redis-1 through redis-6, redis-cluster-init | data |
| postgres-exporter, redis-exporter | data, monitoring |
| nginx-exporter-client/api/ws | edge, monitoring |
| prometheus, alertmanager, alert-inbox, grafana | monitoring |
| monitoring-access, loopback publisher | edge, monitoring |
| cadvisor, opt-in | monitoring |

The public application nginx containers cannot connect directly to datastores or monitoring services. A separate `monitoring-access` nginx publishes the monitoring UIs on host loopback because Docker does not publish ports for containers attached only to internal networks. Its UI listeners accept only host loopback and the reserved edge gateway `.1`, and reject other edge containers. The host firewall must still restrict all published ports. If a container runtime presents a different host source address, add only that exact address to `MESSENGER_MONITORING_ALLOWED_PEERS` after verifying it in the monitoring proxy's access log. Nginx exporters join edge to scrape status ports; their only published surface is their internal network endpoint. No monitoring container uses host networking or a publicly bound port. Containers that bridge networks remain trusted; network separation does not protect against a compromised Docker host.

The reserved defaults are `10.245.0.0/24` for data, `10.246.0.0/24` for app and `10.247.0.0/24` for edge. Choose unused ranges if they overlap existing networks. Change `MESSENGER_SUBNET` and `MESSENGER_REDIS_IP_PREFIX` together, `MESSENGER_APP_SUBNET` and `MESSENGER_APP_IP_PREFIX` together, and `MESSENGER_EDGE_SUBNET` and `MESSENGER_EDGE_IP_PREFIX` together. When changing app addresses, also change `MESSENGER_HTTP_PROXY_PATTERN` to a regex matching only API-proxy's reserved `.10` address. Dynamic addresses use the upper half of each subnet; reserved service addresses use the lower half.

Public nginx containers drop all capabilities, add only those required for port binding and worker/cache ownership, prohibit privilege escalation and use a read-only filesystem with temporary config, runtime and cache mounts. Header/body/send timeouts, upstream keepalive, request and connection limits apply at the edge. `MESSENGER_CONNECTION_LIMIT` defaults to 200 simultaneous active requests or sockets per client IP at each nginx layer. Set it for legitimate shared NAT traffic and capacity tests.

cAdvisor is disabled unless `--profile container-metrics` is selected. It has no privileged flag and mounts only rootfs, sysfs, Docker storage and the specific containerd socket, not `/var/run` or the Docker API socket. The containerd socket still grants sensitive host access. Enable it only on a trusted Linux host after verifying useful metrics under its host's cgroup/runtime setup. Some hosts need additional access; decide that explicitly before enabling the profile. The existing `npm run monitoring:check` expects cAdvisor and the old fixed Grafana password, so provide the generated `GRAFANA_ADMIN_PASSWORD` and enable the profile on a compatible host when using that check.

## Monitoring access

Prometheus, Alertmanager, Grafana and the alert inbox bind to host loopback only. Loopback UIs without authentication, including Prometheus and Alertmanager, still have DNS-rebinding and browser-origin risks on the operator's machine. Use a trusted SSH tunnel for remote access, keep their ports closed in the host firewall, and do not put them behind the public LB.

```sh
ssh -N -L 19090:127.0.0.1:9090 -L 19093:127.0.0.1:9093 \
  -L 13000:127.0.0.1:3000 operator@messenger-host
```

Open the forwarded localhost ports only from a trusted browser environment. Grafana uses the generated or provisioned admin password. Use an authenticated private reverse proxy if a team needs shared monitoring access. Internal-only monitoring also means external alert delivery and dashboard plugin downloads need an explicitly designed egress path; the default alert receiver is the private alert inbox.
