BEGIN;
DO $$
BEGIN
    IF NOT 'pg_stat_statements' = ANY(string_to_array(replace(current_setting('shared_preload_libraries'), ' ', ''), ',')) THEN
        RAISE EXCEPTION 'Restart PostgreSQL with pg_stat_statements preloaded before installing observability';
    END IF;
END
$$;
CREATE SCHEMA IF NOT EXISTS observability;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA observability;
DO $$
BEGIN
    IF (SELECT extnamespace <> 'observability'::regnamespace FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
        ALTER EXTENSION pg_stat_statements SET SCHEMA observability;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA observability TO messenger_exporter;
GRANT SELECT ON ALL TABLES IN SCHEMA observability TO messenger_exporter;
COMMIT;
