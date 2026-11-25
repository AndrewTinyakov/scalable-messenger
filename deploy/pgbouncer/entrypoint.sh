#!/bin/sh
set -eu
config=/run/pgbouncer
umask 077

role_pool=${PGBOUNCER_POOL_SIZE:-20}
api_pool=${PGBOUNCER_API_POOL_SIZE:-$role_pool}
database_cap=${PGBOUNCER_MAX_DB_CONNECTIONS:-80}
for size in "$role_pool" "$api_pool" "$database_cap"; do
  case $size in
    '' | *[!0-9]* | 0*)
      echo "Pool sizes must be positive integers" >&2
      exit 64
      ;;
  esac
done
if [ "$api_pool" -gt $((database_cap - 2 * role_pool)) ]; then
  echo "PGBOUNCER_API_POOL_SIZE=$api_pool leaves no room for the other roles within $database_cap connections" >&2
  exit 64
fi

quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"
}

{
  printf '%s %s\n' "$(quote messenger_api)" "$(quote "$POSTGRES_API_PASSWORD")"
  printf '%s %s\n' "$(quote messenger_command)" "$(quote "$POSTGRES_COMMAND_PASSWORD")"
  printf '%s %s\n' "$(quote messenger_publisher)" "$(quote "$POSTGRES_PUBLISHER_PASSWORD")"
} > "$config/userlist.txt"

cat > "$config/pgbouncer.ini" <<INI
[databases]
messenger = host=${PGBOUNCER_SERVER_HOST:-postgres} port=5432 dbname=messenger

[users]
messenger_api = pool_size=$api_pool

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
unix_socket_dir =
auth_type = scram-sha-256
auth_file = $config/userlist.txt
pool_mode = transaction
max_client_conn = ${PGBOUNCER_MAX_CLIENT_CONN:-2000}
default_pool_size = $role_pool
max_db_connections = $database_cap
max_prepared_statements = ${PGBOUNCER_MAX_PREPARED_STATEMENTS:-1024}
ignore_startup_parameters = extra_float_digits
server_reset_query =
server_lifetime = 3600
server_idle_timeout = 600
query_wait_timeout = 30
log_connections = 0
log_disconnections = 0
admin_users =
stats_users =
INI

exec pgbouncer "$config/pgbouncer.ini"
