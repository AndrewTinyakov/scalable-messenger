import { Pool } from "pg";
import { Store } from "./db/index.js";
import { RedisRooms } from "./brokers/index.js";
import { config } from "./config.js";
import { createApi } from "./api.js";
const pool = new Pool({ connectionString: config.databaseUrl });
const rooms = await RedisRooms.connect(config.redisUrl);
const app = createApi(new Store(pool), {
  ...config,
  rateLimit: (key) => rooms.rateLimit(key),
});
await app.listen({ port: config.apiPort, host: "0.0.0.0" });
const stop = async () => {
  await app.close();
  await rooms.close();
  await pool.end();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
