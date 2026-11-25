# Messenger

A chat prototype with React, Kotlin HTTP and workers, and Go WebSocket nodes.

Start the local Docker Compose stack with the HTTPS browser defaults. In an existing `.env`, remove any old `MESSENGER_SESSION_COOKIE_SECURE=false` or `MESSENGER_PUBLIC_SCHEME=http` entries, or change them to `true` and `https`. Set any existing `MESSENGER_CLIENT_ORIGIN` to `https://messenger.localhost` for this setup. The launcher preserves existing settings and credentials.

```sh
scripts/dev-up.sh
```

Compose runs the backend and publishes the API proxy on `127.0.0.1:8081` and the WS proxy on `127.0.0.1:8082`. The React app runs separately with npm and Vite and talks to both proxies directly. Use Portless with its default HTTPS listener on port 443. [Portless](https://github.com/vercel-labs/portless)

```sh
portless proxy start
portless alias api.messenger 8081
portless alias ws.messenger 8082
cd client
npm ci
portless run --name messenger --prefix '' npm run dev
```

Open https://messenger.localhost. Vite serves hot reload there and the app calls https://api.messenger.localhost/api and wss://ws.messenger.localhost/ws. To check the production build, stop the dev server, build for the same endpoints, and serve `dist`:

```sh
VITE_API_BASE_URL=https://api.messenger.localhost/api \
VITE_WS_URL=wss://ws.messenger.localhost/ws npm run build
portless run --name messenger --prefix '' npm run preview
```

`--prefix ''` keeps `https://messenger.localhost` in a Git worktree, matching Compose's default `MESSENGER_CLIENT_ORIGIN`.

To run a second stack alongside the primary one, configure its worktree's `.env` with a unique `COMPOSE_PROJECT_NAME` such as `messenger-feature` and `MESSENGER_CLIENT_ORIGIN=https://feature.messenger.localhost`. Give it unused API, WS, and monitoring host ports and unused Compose subnets with matching IP prefixes and API proxy address. Then run `scripts/dev-up.sh` in that worktree. A separate project keeps its containers and database volume independent. [Network settings](docs/deployment.md#network-and-host-isolation)

Alias `api.feature.messenger` and `ws.feature.messenger` to the second stack's published API and WS ports. Set `VITE_API_BASE_URL` and `VITE_WS_URL` to those aliases for both dev and build. Use `--prefix feature` for both Vite commands.

Portless terminates TLS, and the proxies tell upstream services the public scheme is HTTPS. For static hosting and production routing, see the [deployment guide](docs/deployment.md). For explicit HTTP test settings, see the [cross-system test guide](tests/README.md).

Local startup requires Node.js 24.15 or later, Go, OpenSSL and Docker Compose. Secrets live in ignored `.env` and `.local/secrets`; existing values persist across runs. Use `scripts/dev-up.sh --prepare-only` to prepare configuration without starting the stack. The launcher creates development-only gRPC certificates in the ignored `.local/grpc` directory and preserves valid existing material. Partial, expired, mismatched or incorrectly permissioned material fails startup. These credentials are for local development.

The WS gateway verifies the browser's signed ticket and sends session IDs to the API over mutual TLS. The ticket only admits the handshake; open sockets recheck their session every five minutes. Only API instances and WS gateways join the internal `grpc` network. Both APIs share `api-grpc`; each binds gRPC to its own `api-1-grpc` or `api-2-grpc` interface. Go connects directly to `dns:///api-grpc:9090` and verifies the `api-grpc` server identity. The API requires a certificate from the development CA with URI identity `spiffe://messenger/ws`. nginx handles HTTP; gRPC has no published host port.

The generator writes PKCS8 private keys with mode `0600` by default and certificates with `0644`. The launcher passes your primary group ID to share only the API and WS service keys with mode `0640`. It records that ID as `MESSENGER_GRPC_GID` in `.env`, and Compose adds the group to the nonroot containers. The launcher rejects an existing group setting that differs from `id -g`. Each container gets individual read-only mounts for its certificate, its key and the CA certificate. The CA private key stays on the host. This uses host file ownership, rather than Compose secret permission fields that file bind mounts do not enforce. The host group must contain only users trusted with local service credentials.

Leaf certificates last 90 days; the local CA lasts five years. To intentionally replace all local gRPC credentials, stop their consumers, remove the whole directory, and restart:

```sh
docker compose stop api-1 api-2 ws
rm -rf .local/grpc
scripts/dev-up.sh
```

The browser page and the HTTP API must be on the same site (for example `example.com` and `api.example.com`) for the `SameSite=Strict` session cookie. The HTTPS workflow uses the host-only `__Host-messenger_session` cookie with `Secure`. Explicit HTTP tests can use `MESSENGER_SESSION_COOKIE_SECURE=false`, which issues `messenger_session` under the API path.

Sessions are opaque tokens stored as SHA-256 hashes. A session expires 30 days after its last use; requests extend it at most once a day and re-issue the cookie. Users can list their signed-in devices, sign out one or all others, and change their password, which signs out every other device and gives this browser a new session token; the old token keeps working for one minute so requests already in flight succeed. Each revocation closes that session's sockets; a browser whose socket is closed checks its HTTP session before signing out. Renewal changes only the server-side expiry and never re-sends the cookie, which lasts 400 days (the browser maximum), so a continuously active user signs in again after 400 days. After five failed logins for one username from one client address, further attempts from that address back off from 1 second up to 15 minutes, with the same response for unknown usernames. Failures from one address do not block other addresses. Monitoring endpoints alone accept HTTP Basic credentials.

The development schema now uses PostgreSQL enums and expects a fresh database. The existing migration was updated in place. Recreate an older local database before starting this version. Chat kinds use `DIRECT` and `GROUP` in HTTP and socket payloads; HTTP send lookup statuses are uppercase too. Contract generation supplies the Kotlin, Go and TypeScript protocol vocabularies.

Password encoders are configured under `messenger.auth.password` in [the API YAML](kotlin/api/src/main/resources/application.yaml). When changing encoding settings, add an encoder under a new ID and select it with `id-for-encode`. Keep existing IDs and their settings so stored passwords remain verifiable. Tagged and untagged bcrypt passwords remain supported.

The same YAML configures browser origins, CORS methods, headers and credentials under `messenger.web.cors`, and endpoint rules under `messenger.web.security`. Endpoint patterns are relative to `spring.mvc.servlet.path`: with `/api`, use `/v1/auth/login` for the URL `/api/v1/auth/login`. The first matching group wins in this order: OPTIONS preflight, public, monitoring, denied. Remaining requests reach the application's session checks. Every configured origin must be an exact HTTP or HTTPS origin without a path or trailing slash; browser mutations still require one Origin header and `X-Messenger-CSRF: 1`.

On pull requests and pushes to `main`, [CI](.github/workflows/verify.yaml) compiles Kotlin and Go, builds the client, runs linters and Go/client unit tests, and checks contracts, deployment configuration and fast AsyncAPI model generation. It also runs the API and outbox publisher Testcontainers tests. It can also be started manually. Superseded runs are canceled. Command-processor tests, dependency audits, full infrastructure, HTTP/SQL/gRPC generation checks, resilience and load checks run locally.

Use [package.json](package.json) for generation and verification commands, and [compose.yaml](compose.yaml) for runtime settings. [CONTEXT.md](CONTEXT.md) defines terms; the [broker decision](docs/adr/0001-messenger-broker-split.md) records delivery guarantees.

See [WebSocket scalability](docs/scalability.md) for replica settings, capacity workloads, and measured performance changes.

From either Go module, format a source file with `go tool goimports -w -local messenger/ws,messenger/tests/load/ws path/to/file.go`. The tool version is pinned in each module. `npm run format:go` formats handwritten sources in both modules, and `npm run format:go:check` checks them.

Format Kotlin with `./kotlin/gradlew -p kotlin ktlintFormat` and check it with `./kotlin/gradlew -p kotlin ktlintCheck`.

Audit Kotlin runtime dependencies with `./kotlin/gradlew -p kotlin osvSbom`. Gradle builds a CycloneDX inventory and scans it with the pinned OSV CLI. Findings and scan errors fail the task; no API key is needed.

Edit dashboard JSON directly in [deploy/grafana/dashboards](deploy/grafana/dashboards). Grafana provisions these files through Compose. Run `npm run monitoring:check` against the running stack to check targets, dashboards and panel queries.

Monitoring UIs remain on loopback. Use a trusted SSH tunnel for remote access and the generated Grafana admin password. See [monitoring access](docs/deployment.md#monitoring-access) for the remaining DNS-rebinding risk.
