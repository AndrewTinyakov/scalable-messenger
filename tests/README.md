# Cross-system checks

These checks exercise the running messenger through its public HTTP and WebSocket endpoints. Kotlin, Go, client and contract unit/integration tests stay in their owning projects.

- `system/` covers authentication, saved messages and group membership.
- `resilience/` covers gateway drain, stopped processors, RabbitMQ failover and Redis recovery.
- `support/` holds runtime settings, clients and fixtures shared by those scenarios.
- `monitoring/` checks live Prometheus targets, metrics and Grafana dashboards.
- `load/ws/` is an independent Go module for idle, fanout, slow-reader, reconnect and drain workloads.

Start the Compose stack before running cross-system checks:

```sh
scripts/dev-up.sh
npm run test:system
npm run test:resilience
npm run monitoring:check
```

The launcher provisions local gRPC certificates and the service-key group before starting Compose. Run the certificate generator checks without a stack with `go -C ws test ./cmd/grpc-certs`. They cover certificate identities and TLS purposes, PKCS8 keys, permissions, group access, idempotency and rejection of invalid existing material. Full gRPC/HTTP/SQL regeneration, infrastructure and resilience checks run locally. Automatic CI compiles, lints, runs Go/client unit tests and checks fast AsyncAPI generation without starting containers.

`test:resilience` runs the system cases and infrastructure-failure cases sequentially. Failure scenarios stop and restart parts of the stack, so use a dedicated test deployment. Worker restart waits for every replica's health endpoint; Redis recovery precedes publisher startup.

Runtime defaults match local Compose. Set `MESSENGER_API_BASE_URL`, `MESSENGER_WS_URL` and `MESSENGER_CLIENT_ORIGIN` for alternate endpoints. Set `MESSENGER_COMPOSE_PROJECT` and `MESSENGER_COMPOSE_OVERRIDE` when the failure scenarios target a named project or an override file. Load that deployment's environment files into the test process too, so Docker subprocesses retain its network and runtime settings. `MESSENGER_WS_REPLICAS` sets the expected gateway count.

The headless clients can use the published loopback ports directly and send session cookies themselves. To test HTTP forwarding and non-Secure cookies explicitly, start a dedicated stack with these overrides and give the tests the same Origin:

```sh
export MESSENGER_PUBLIC_SCHEME=http
export MESSENGER_SESSION_COOKIE_SECURE=false
export MESSENGER_CLIENT_ORIGIN=http://localhost:5173
export MESSENGER_API_BASE_URL=http://localhost:8081/api
export MESSENGER_WS_URL=ws://localhost:8082/ws
scripts/dev-up.sh
npm run test:system
```

Use a separate shell for these exports. To run both stacks at once, give the test stack its own Compose project, loopback ports and network ranges, and point the test URLs at those ports. For browser HTTPS and Secure cookie checks, use the [Portless workflow](../README.md).

The load module has tests that run without a stack:

```sh
npm run test:load
npm run load:ws -- -h
```

Run a small public fanout check against the default local stack:

```sh
npm run load:ws -- \
  -mode fanout -bootstrap-users 2 -connections 4 \
  -duration 3s -rate 5 -observe-metrics -compose-project messenger
```

See [the capacity guide](../docs/scalability.md) for session manifests, longer workloads, resource checks and measurement limits.
