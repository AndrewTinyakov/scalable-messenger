#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 \
  --set=api_password="$POSTGRES_API_PASSWORD" \
  --set=command_password="$POSTGRES_COMMAND_PASSWORD" \
  --set=publisher_password="$POSTGRES_PUBLISHER_PASSWORD" \
  --set=migrator_password="$POSTGRES_MIGRATOR_PASSWORD" \
  --set=exporter_password="$POSTGRES_EXPORTER_PASSWORD" <<'SQL'
CREATE ROLE messenger_runtime NOLOGIN;
CREATE ROLE messenger_api LOGIN PASSWORD :'api_password' IN ROLE messenger_runtime;
CREATE ROLE messenger_command LOGIN PASSWORD :'command_password' IN ROLE messenger_runtime;
CREATE ROLE messenger_publisher LOGIN PASSWORD :'publisher_password' IN ROLE messenger_runtime;
CREATE ROLE messenger_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE messenger_exporter LOGIN PASSWORD :'exporter_password' IN ROLE pg_monitor;
ALTER DATABASE messenger OWNER TO messenger_migrator;
REVOKE ALL ON DATABASE messenger FROM PUBLIC;
GRANT CONNECT ON DATABASE messenger TO messenger_runtime, messenger_exporter;
ALTER SCHEMA public OWNER TO messenger_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO messenger_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE messenger_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO messenger_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE messenger_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO messenger_runtime;
SQL
