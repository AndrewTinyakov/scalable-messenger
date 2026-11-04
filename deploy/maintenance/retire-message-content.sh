#!/usr/bin/env bash
set -euo pipefail

project=${1:?Pass the Compose project whose retired message content should be removed}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
services=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Label "com.docker.compose.service"}}')
if [[ "$services" =~ (^|$'\n')(api-[12]|ws|messenger-command-processor|messenger-outbox-publisher)($|$'\n') ]]; then
    echo 'Stop this project’s API, gateway, command processor and publisher services before retirement.' >&2
    exit 1
fi
postgres=$(docker ps --filter "label=com.docker.compose.project=$project" --filter 'label=com.docker.compose.service=postgres' --format '{{.ID}}')
[[ -n "$postgres" && "$postgres" != *$'\n'* ]] || { echo 'Expected one running project PostgreSQL container.' >&2; exit 1; }
converted=0
while true; do
    rows=$(docker exec -i "$postgres" psql -U messenger -d messenger -At -v ON_ERROR_STOP=1 < "$script_dir/bodyless-outbox.sql")
    [[ "$rows" =~ ^[0-9]+$ ]] || { echo 'Unexpected retirement result.' >&2; exit 1; }
    converted=$((converted + rows))
    [[ "$rows" != 0 ]] || break
done
rooms=0
keys_file=$(mktemp)
trap 'rm -f "$keys_file"' EXIT
redis_nodes=$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.ID}} {{.Label "com.docker.compose.service"}}' | awk '$2 ~ /^redis-[1-6]$/ {print $1}')
[[ -n "$redis_nodes" ]] || { echo 'No project Redis nodes found.' >&2; exit 1; }
while IFS= read -r redis; do
    [[ -n "$redis" ]] || continue
    docker exec "$redis" redis-cli -e --scan --pattern 'messenger:{*}:stream' > "$keys_file"
    while IFS= read -r stream; do
        [[ -n "$stream" ]] || continue
        prefix=${stream%:stream}
        removed=$(docker exec "$redis" redis-cli -e -c UNLINK "$stream" "$prefix:epoch" "$prefix:history-bytes")
        [[ "$removed" =~ ^[0-9]+$ ]] || { echo 'Unexpected replay retirement result.' >&2; exit 1; }
        if [[ "$removed" != 0 ]]; then rooms=$((rooms + 1)); fi
    done < "$keys_file"
done <<< "$redis_nodes"
printf 'Converted %s outbox rows; retired %s room replay streams.\n' "$converted" "$rooms"
