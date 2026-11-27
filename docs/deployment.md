# Deploying Messenger

Messenger runs as three public endpoints on one registrable domain:

| Public origin | Serves | Route |
| --- | --- | --- |
| `https://example.com` | React static files | Static CDN, for example a private S3 bucket behind CloudFront |
| `https://api.example.com` | `/api/v1/*`, `/healthz` | TLS load balancer → `api-proxy` → `api-1` or `api-2` |
| `https://ws.example.com` | `/ws`, `/healthz` | TLS load balancer → `ws-proxy` → a WS replica |

Compose runs only the API and WS side. The frontend is a plain directory of files, so deploying it never touches open sockets, and restarting the proxies never touches the frontend. Keep the API host on the same registrable domain as the page: the session cookie is host-only on the API host with `SameSite=Strict`, which browsers send on same-site cross-origin requests only.

## Static frontend

Build the frontend with the public endpoints. The values are compiled into the bundle and into the page's Content-Security-Policy `connect-src`, so build once per environment:

```sh
npm --prefix client ci
VITE_API_BASE_URL=https://api.example.com/api \
VITE_WS_URL=wss://ws.example.com/ws \
  npm --prefix client run build
```

The build fails when either value is missing, when it contains credentials, a query or a fragment, when HTTP is mixed with WSS (or HTTPS with WS), or when a non-loopback endpoint is not HTTPS/WSS. `client/dist` contains `index.html`, `favicon.svg` and content-hashed files under `assets/`. Nothing in it is specific to a cloud provider.

Configure the CDN with:

- **Origin access.** Keep the bucket or origin private and allow only the CDN to read it (for CloudFront, origin access control).
- **SPA fallback.** Serve `/index.html` with status 200 for paths that are not files, so client-side routes such as `/users/{id}` load. For S3 behind CloudFront, map 403 and 404 origin errors to `/index.html` with 200.
- **Caching.** Set `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` and `Cache-Control: no-cache` for `index.html` and every other path. In CloudFront, use a cache policy with a minimum TTL of 0 for HTML so it honors `no-cache`.
- **Response headers** on every response:

  | Header | Value |
  | --- | --- |
  | `Strict-Transport-Security` | `max-age=31536000` |
  | `Content-Security-Policy` | `frame-ancestors 'none'` (the build's `<meta>` policy covers the rest; a CDN may also send the full policy, `default-src 'self'; connect-src 'self' https://api.example.com wss://ws.example.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`) |
  | `X-Content-Type-Options` | `nosniff` |
  | `Referrer-Policy` | `no-referrer` |
  | `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |

- **HTTPS only.** Redirect HTTP to HTTPS at the CDN.

To release, upload `assets/` first, then `favicon.svg` and `index.html`. With CloudFront custom error responses, invalidate `/*` so cached copies of the old HTML at `/`, `/index.html`, and deep links are all evicted. Keep the 403 and 404 error caching TTL low. Keep previous `assets/` files for at least a day so tabs opened before the release can still load them. Old tabs keep their sockets and keep working against the same API and WS endpoints.

### Retire the previous frontend

After the CDN and the separate API and WS hosts serve traffic, remove the old `client` and `nginx-exporter-client` containers. First verify that the old frontend receives no traffic, including any WebSocket connections it still proxies. Run the command from the previous release with the same Compose project name, environment file and Compose files used for that deployment. For example, if it used the production override:

```sh
docker compose -p messenger --env-file /secure/messenger.env \
  -f compose.yaml -f compose.production.yaml rm --stop --force nginx-exporter-client client
```

The service names limit the cleanup to those two containers. Use the current Compose files for later updates.

## API and WS load balancer

Terminate TLS for `api.example.com` and `ws.example.com` at a load balancer and forward HTTP to the published proxy ports, `MESSENGER_API_PORT` (default 8081) and `MESSENGER_WS_PORT` (default 8082). Both proxies answer `/healthz` with 200 for LB liveness; it checks nginx, not downstream readiness. Compose checks gateway `/readyz`; use private `/api/actuator/health` for API readiness. Actuator and stub-status routes must never be LB routes.

Preserve the original Host header, support WebSocket upgrades on the WS host, and set the LB idle timeout above nginx's 75-second socket timeout. Redirect port 80 to HTTPS on port 443.

Set these values in the deployment's protected environment file:

```dotenv
MESSENGER_CLIENT_ORIGIN=https://example.com
MESSENGER_TRUSTED_PROXY_CIDRS=192.0.2.0/24 2001:db8:1234::/64
MESSENGER_BIND_ADDRESS=10.0.1.20
```

`MESSENGER_CLIENT_ORIGIN` is the exact browser origin, including the scheme, lowercase host and non-default port if present. Omit the path and trailing slash. The API's CORS and CSRF checks and the WS gateway's Origin check accept only this value. The API proxy adds CORS headers to nginx-generated 429, 502, 503 and 504 responses. The API adds its own CORS headers and exposes `Retry-After` to the allowed origin on application-generated 429 responses. Browsers still require a successful preflight before sending a request that needs one. When a preflight fails, JavaScript sees a fetch failure. With `MESSENGER_PUBLIC_SCHEME=https`, the API proxy requires an HTTPS origin.

Replace the example CIDRs with the actual source addresses nginx sees from the LB. The values are space-separated IP CIDRs. Trust only LB addresses, never all addresses or an entire shared VPC. If the LB reaches a published port through host NAT, verify the source address observed inside nginx before choosing the CIDR. Reserve a dedicated LB source if NAT collapses trusted and untrusted traffic into the same peer.

Firewall the published proxy ports so only the LB and private health check sources can reach them. Docker's published-port rules can bypass host firewall frontends such as UFW. Enforce the rule in the cloud firewall or Docker forwarding chain as appropriate. `MESSENGER_BIND_ADDRESS` defaults to `127.0.0.1`; select a private host address for a remote LB. Never publish Postgres, Redis, RabbitMQ, actuator, exporters or gRPC.

Nginx uses recursive real-IP processing only for configured trusted peers. It replaces forwarded address, host, port and scheme headers before proxying, and removes `Forwarded`. Rate and connection limits use the resulting real client IP. An untrusted peer cannot choose its limiter key using X-Forwarded-For. The LB must append the actual source IP to X-Forwarded-For or replace that header. Spring's native forwarded-header processing trusts only the reserved API-proxy app address, `10.246.0.10` by default, rather than arbitrary app or private CIDRs.

Login, registration and WS-ticket rate limits count requests per client IP. CORS preflight (`OPTIONS`) requests do not count, so the cross-origin page gets the same budget a same-origin page had.

`MESSENGER_PUBLIC_SCHEME` defaults to `https` in base Compose for local Portless TLS. Both proxies forward the HTTPS scheme and port 443 and send `Strict-Transport-Security: max-age=31536000`. The production override fixes the scheme to `https` and the API's Secure cookie setting to true, and requires `MESSENGER_CLIENT_ORIGIN` and `MESSENGER_TRUSTED_PROXY_CIDRS`.

```sh
docker compose --env-file /secure/messenger.env \
  -f compose.yaml -f compose.production.yaml config --quiet
docker compose --env-file /secure/messenger.env \
  -f compose.yaml -f compose.production.yaml up --build -d
```

The API and gateway validate the configured origin at startup. The API proxy checks that the origin is safe to insert in nginx configuration. Use `compose config` to check interpolation and structure, then verify load balancer reachability and TLS separately.

## Credentials and first initialization

For development, `scripts/dev-up.sh` requires Node.js 24.15 or later, Go, OpenSSL and Docker Compose. On first run `scripts/prepare-dev-env.mjs` generates independent 32-byte random hexadecimal credentials for Postgres admin, migrator, API, command processor, outbox publisher and exporter, Redis, RabbitMQ, the Erlang cluster cookie, metrics, Grafana and WS tickets. It appends missing settings to the ignored `.env` file, preserves existing values and sets mode `0600`. The generated `MESSENGER_SESSION_COOKIE_SECURE=true` matches the HTTPS workflow. To migrate an older `.env`, follow the [local setup instructions](../README.md).

The launcher mirrors the metrics password into ignored `.local/secrets/metrics-password` with mode `0640`. Prometheus mounts that file read-only and joins the host service-credential group through `MESSENGER_GRPC_GID`. The containing directory has mode `0750`. Existing gRPC material stays in ignored `.local/grpc`. `scripts/dev-up.sh --prepare-only` prepares local credentials without starting containers. Do not use the development certificate authority for production.

For production, supply every required `${VAR:?}` credential through a protected environment file or a secret manager. Use independently generated URL-safe passwords, since the RabbitMQ and Redis URLs contain passwords. Keep `METRICS_USERNAME=metrics` and the `METRICS_PASSWORD` environment variable names. Supply a matching metrics password file using `MESSENGER_METRICS_PASSWORD_FILE`, readable by Prometheus's extra credential group. Provision the existing per-service gRPC certificate mounts and group with deployment-specific certificates. Do not put secrets in Docker image layers or tracked files. Container administrators can inspect environment-based secrets; restrict Docker access.

Postgres initializes only fresh database volumes. `postgres` is the admin and observability installer; application containers never receive that password. Each Kotlin service uses its own non-superuser login through the `messenger_runtime` group. That group has table CRUD and sequence access, without schema creation or role administration. The separate `messenger_migrator` role owns the database and schema and creates objects through Flyway. Default privileges give runtime logins access to new public tables and sequences. The exporter receives `pg_monitor` and access to the observability schema, rather than application write privileges.

Flyway currently runs at each service's startup, so those containers also receive the non-superuser migrator credential. Separating migrations into a release job would remove that credential from long-lived services and is a further deployment choice. Runtime privileges are shared across public application tables; these service logins distinguish credentials and connections, rather than enforce table-level service ownership.

Redis requires a password for clients and replication. The cluster initializer, Kotlin publisher, Go gateway's topology and sharded Pub/Sub connections, and Redis exporter authenticate. To connect the Go gateway to an externally TLS-enabled cluster, set `REDIS_URL=rediss://username:password@seed.example:6379/0` alongside `REDIS_CLUSTER_NODES`. Every cluster connection validates its target certificate using system trust and the individual node hostname. The bundled private Compose Redis cluster uses authenticated plaintext; provisioning Redis TLS certificates and listeners is separate.

RabbitMQ uses a random user password and Erlang cookie. Its management UI and cluster ports remain private. Grafana requires an admin password with no fallback. A persistent Grafana database retains its existing admin password; changing the environment alone does not rotate it.

Existing Postgres/RabbitMQ/Redis volumes do not automatically rotate credentials or create new Postgres roles. Back up data and apply the equivalent role/credential changes in a maintenance window before switching an existing deployment. Never delete persistent volumes to perform a production upgrade. For disposable development data, create a fresh Compose project and network ranges. Preserve the generated environment file across restarts.

## Presence Redis

Set `PRESENCE_REDIS_URL` and `PRESENCE_REDIS_CLUSTER_NODES` consistently on the gateway and outbox publisher so that presence revocations reach the gateway's subscriptions. When both settings are empty, the publisher uses its room Redis connection. An empty presence node list inherits the room cluster nodes. An empty presence URL inherits the room credentials and TLS settings. An explicit URL supplies its own credentials and TLS scheme. For a standalone URL, `?db=` takes precedence over the path's database number. The publisher opens its dedicated presence connection at startup.

## Network and host isolation

Only `edge` permits external routing. `app`, `data`, `monitoring` and the existing `grpc` network are internal.

| Service | Networks |
| --- | --- |
| api-proxy, ws-proxy | edge, app |
| api-1, api-2, ws replicas | app, data, monitoring, grpc |
| command processor, outbox publisher | data, monitoring |
| postgres, pgbouncer, postgres-observability-init | data |
| rabbitmq-1/2/3 | data, monitoring |
| rabbitmq-cluster-init, redis-1 through redis-6, redis-cluster-init | data |
| postgres-exporter, redis-exporter | data, monitoring |
| nginx-exporter-api/ws | edge, monitoring |
| prometheus, alertmanager, alert-inbox, grafana | monitoring |
| monitoring-access, loopback publisher | edge, monitoring |
| cadvisor, opt-in | monitoring |

The public application nginx containers cannot connect directly to datastores or monitoring services. A separate `monitoring-access` nginx publishes the monitoring UIs on host loopback because Docker does not publish ports for containers attached only to internal networks. Its UI listeners accept only host loopback and the reserved edge gateway `.1`, and reject other edge containers. The host firewall must still restrict all published ports. If a container runtime presents a different host source address, add only that exact address to `MESSENGER_MONITORING_ALLOWED_PEERS` after verifying it in the monitoring proxy's access log. Nginx exporters join edge to scrape status ports; their only published surface is their internal network endpoint. No monitoring container uses host networking or a publicly bound port. Containers that bridge networks remain trusted; network separation does not protect against a compromised Docker host.

The reserved defaults are `10.245.0.0/24` for data, `10.246.0.0/24` for app and `10.247.0.0/24` for edge. Choose unused ranges if they overlap existing networks. Change `MESSENGER_SUBNET` and `MESSENGER_REDIS_IP_PREFIX` together, `MESSENGER_APP_SUBNET` and `MESSENGER_APP_IP_PREFIX` together, and `MESSENGER_EDGE_SUBNET` and `MESSENGER_EDGE_IP_PREFIX` together. When changing app addresses, also change `MESSENGER_HTTP_PROXY_PATTERN` to a regex matching only API-proxy's reserved `.10` address. Dynamic addresses use the upper half of each subnet; reserved service addresses use the lower half.

Public nginx containers drop all capabilities, add only those required for port binding and worker/cache ownership, prohibit privilege escalation and use a read-only filesystem with temporary config, runtime and cache mounts. Header/body/send timeouts, upstream keepalive, request and connection limits apply at the edge. `MESSENGER_CONNECTION_LIMIT` defaults to 200 simultaneous active requests or sockets per client IP at each proxy. Set it for legitimate shared NAT traffic and capacity tests.

cAdvisor is disabled unless `--profile container-metrics` is selected. It has no privileged flag and mounts only rootfs, sysfs, Docker storage and the specific containerd socket, not `/var/run` or the Docker API socket. The containerd socket still grants sensitive host access. Enable it only on a trusted Linux host after verifying useful metrics under its host's cgroup/runtime setup. Some hosts need additional access; decide that explicitly before enabling the profile. The existing `npm run monitoring:check` expects cAdvisor and the old fixed Grafana password, so provide the generated `GRAFANA_ADMIN_PASSWORD` and enable the profile on a compatible host when using that check.

## Monitoring access

Prometheus, Alertmanager, Grafana and the alert inbox bind to host loopback only. Loopback UIs without authentication, including Prometheus and Alertmanager, still have DNS-rebinding and browser-origin risks on the operator's machine. Use a trusted SSH tunnel for remote access, keep their ports closed in the host firewall, and do not put them behind the public LB.

```sh
ssh -N -L 19090:127.0.0.1:9090 -L 19093:127.0.0.1:9093 \
  -L 13000:127.0.0.1:3000 operator@messenger-host
```

Open the forwarded localhost ports only from a trusted browser environment. Grafana uses the generated or provisioned admin password. Use an authenticated private reverse proxy if a team needs shared monitoring access. Internal-only monitoring also means external alert delivery and dashboard plugin downloads need an explicitly designed egress path; the default alert receiver is the private alert inbox.
