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

The launcher provisions local gRPC certificates and the service-key group before starting Compose. CI runs `go -C ws run ./cmd/grpc-certs -out ../.local/grpc -service-key-group "$(id -g)"` and sets `MESSENGER_GRPC_GID` to the same group before starting its stack. Run the certificate generator checks without a stack with `go -C ws test ./cmd/grpc-certs`. They cover certificate identities and TLS purposes, PKCS8 keys, permissions, group access, idempotency and rejection of invalid existing material. CI also regenerates Kotlin and Go gRPC models from the shared proto and checks for differences.

`test:resilience` runs the system cases and infrastructure-failure cases sequentially. Failure scenarios stop and restart parts of the stack, so use a dedicated test deployment.

Runtime defaults match local Compose. Set `MESSENGER_API_BASE_URL`, `MESSENGER_WS_URL` and `MESSENGER_CLIENT_ORIGIN` for alternate endpoints. Set `MESSENGER_COMPOSE_PROJECT` and `MESSENGER_COMPOSE_OVERRIDE` when the failure scenarios target a named project or an override file. `MESSENGER_WS_REPLICAS` sets the expected gateway count.

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
