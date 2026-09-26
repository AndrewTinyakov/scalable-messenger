import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "../src/config.js";
import { Store } from "../src/db/index.js";

export function createTestDatabase() {
  const schema = `messenger_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: config.databaseUrl });
  const pool = new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${schema}`,
  });
  const store = new Store(pool);
  let created = false;
  return {
    pool,
    store,
    async start() {
      await admin.query(`CREATE SCHEMA ${schema}`);
      created = true;
      await store.migrate();
    },
    async close() {
      try {
        await pool.end();
        if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
