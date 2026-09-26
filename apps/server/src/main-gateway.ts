import { Pool } from "pg";
import { Store } from "./db/index.js";
import { CommandBroker, RedisRooms } from "./brokers/index.js";
import { config } from "./config.js";
import { createGateway } from "./gateway.js";
const pool = new Pool({ connectionString: config.databaseUrl });
let stopping = false;
let app: ReturnType<typeof createGateway> | undefined;
let broker: CommandBroker | undefined;
let rooms: RedisRooms | undefined;
let wake: () => void = () => {};
async function stop() {
  stopping = true;
  wake();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
while (!stopping) {
  try {
    broker = await CommandBroker.connect(config.rabbitUrl);
    rooms = await RedisRooms.connect(config.redisUrl);
    const disconnected = new Promise<void>((resolve) => {
      wake = resolve;
      broker!.onDisconnect(resolve);
    });
    app = createGateway(new Store(pool), broker, rooms, config);
    await app.listen({ port: config.gatewayPort, host: "0.0.0.0" });
    await disconnected;
  } catch (error) {
    if (!stopping)
      console.error("Gateway restarting after dependency failure", error);
  } finally {
    await app?.close();
    await broker?.close().catch(() => {});
    await rooms?.close().catch(() => {});
    app = undefined;
    broker = undefined;
    rooms = undefined;
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
}
await pool.end();
