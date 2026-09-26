import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RedisRooms } from "./brokers/index.js";
import { config } from "./config.js";
import { Store } from "./db/index.js";

const pool = new Pool({ connectionString: config.databaseUrl });
const store = new Store(pool);
const owner = randomUUID();
let stopping = false;
let rooms: RedisRooms | undefined;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  while (!stopping) {
    try {
      rooms ??= await RedisRooms.connect(config.redisUrl);
      const batch = await store.claimOutbox(owner, 50);
      for (const row of batch) {
        if (stopping) break;
        try {
          await rooms.publish(row.room, row.event);
          await store.completeOutbox(owner, row.id);
        } catch (error) {
          console.error("Outbox publication failed:", error);
          await store.failOutbox(owner, row.id, error);
        }
      }
      if (batch.length === 0) await delay(250);
    } catch (error) {
      if (!stopping) console.error("Outbox relay unavailable:", error);
      await rooms?.close().catch(() => undefined);
      rooms = undefined;
      if (!stopping) await delay(1_000);
    }
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await rooms?.close().catch(() => undefined);
  await pool.end();
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
