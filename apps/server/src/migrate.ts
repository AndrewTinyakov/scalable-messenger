import pg from "pg";
import { Store } from "./db/index.js";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://messenger:messenger@localhost:55432/messenger",
});
try {
  await new Store(pool).migrate();
  console.log("Database migrations complete");
} finally {
  await pool.end();
}
