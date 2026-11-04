#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
umask 077
if [ ! -f .env ] || ! grep -q '^WS_TICKET_SECRET=' .env; then
  printf '\nWS_TICKET_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
fi
grpc_gid="$(id -g)"
if ! grep -q '^MESSENGER_GRPC_GID=' .env; then
  printf '\nMESSENGER_GRPC_GID=%s\n' "$grpc_gid" >> .env
elif ! grep -qx "MESSENGER_GRPC_GID=$grpc_gid" .env; then
  printf '%s\n' 'MESSENGER_GRPC_GID in .env must match id -g before preparing certificates.' >&2
  exit 1
fi
go -C ws run ./cmd/grpc-certs -out ../.local/grpc -service-key-group "$grpc_gid"
exec docker compose up --build -d "$@"
