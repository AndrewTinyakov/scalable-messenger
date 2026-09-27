#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."
umask 077
if [ ! -f .env ] || ! grep -q '^WS_TICKET_SECRET=' .env; then
  printf '\nWS_TICKET_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
fi
exec docker compose up --build -d "$@"
