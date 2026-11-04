CREATE FUNCTION acquire_transaction_lock(lock_key text) RETURNS void
LANGUAGE sql VOLATILE
AS $$
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lock_key, 0));
$$;
