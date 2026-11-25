#!/bin/sh
set -eu
{
  for cidr in 127.0.0.1/32 ${MONITORING_HOST_CIDR:?Set the edge gateway CIDR} ${MONITORING_ALLOWED_PEERS:-}; do
    case "$cidr" in
      *[!0-9a-fA-F:./]*) echo 'Monitoring peers must be space-separated IP CIDRs' >&2; exit 1 ;;
    esac
    printf 'allow %s;\n' "$cidr"
  done
  printf '%s\n' 'deny all;'
} > /var/run/monitoring-access.inc
if [ "$#" -eq 0 ]; then set -- nginx -g 'daemon off;'; fi
exec /docker-entrypoint.sh "$@"
