#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
umask 077
node scripts/prepare-dev-env.mjs
grpc_gid="$(id -g)"
go -C ws run ./cmd/grpc-certs -out ../.local/grpc -service-key-group "$grpc_gid"
if [ "${1:-}" = '--prepare-only' ]; then exit 0; fi
exec docker compose up --build -d "$@"
