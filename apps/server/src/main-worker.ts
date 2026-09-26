import { Pool } from "pg";
import { CommandBroker } from "./brokers/index.js";
import { config } from "./config.js";
import { Store } from "./db/index.js";

const pool = new Pool({ connectionString: config.databaseUrl });
const store = new Store(pool);
let stopping = false;
let current: CommandBroker | undefined;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  while (!stopping) {
    try {
      const broker = await CommandBroker.connect(config.rabbitUrl);
      current = broker;
      const disconnected = new Promise<void>((resolve) =>
        broker.onDisconnect(resolve),
      );
      await broker.consume((command) => store.processCommand(command));
      await disconnected;
    } catch (error) {
      if (!stopping) console.error("Worker broker unavailable:", error);
    } finally {
      const broker = current;
      current = undefined;
      if (broker) await broker.close().catch(() => undefined);
    }
    if (!stopping) await delay(1_000);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await current?.close().catch(() => undefined);
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
