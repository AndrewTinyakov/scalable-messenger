#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
container=messenger-chat-activity-benchmark
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --memory 768m --cpus 2 \
  -e POSTGRES_USER=messenger -e POSTGRES_PASSWORD=messenger -e POSTGRES_DB=messenger postgres:17-alpine
until docker exec "$container" pg_isready -U messenger >/dev/null 2>&1; do sleep 1; done
for version in {1..10}; do
  docker exec -i "$container" psql -U messenger -v ON_ERROR_STOP=1 < kotlin/shared/src/main/resources/db/migration/V"${version}"__*.sql
done
docker exec -i "$container" psql -U messenger -v ON_ERROR_STOP=1 < docs/evidence/sidebar-seed.sql
docker exec "$container" psql -U messenger -v ON_ERROR_STOP=1 -c 'UPDATE chats SET last_activity_at=NULL'
docker exec -i "$container" psql -U messenger -v ON_ERROR_STOP=1 < kotlin/shared/src/main/resources/db/migration/V11__backfill_chat_activity.sql
