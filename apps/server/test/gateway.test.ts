import { beforeAll, afterAll, test, expect } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { serverFrameSchema, type ServerFrame } from "@messenger/contracts";
import { Store } from "../src/db/index.js";
import { CommandBroker, RedisRooms } from "../src/brokers/index.js";
import { createGateway } from "../src/gateway.js";
import { config } from "../src/config.js";
const pool = new Pool({ connectionString: config.databaseUrl });
const store = new Store(pool);
let broker: CommandBroker,
  rooms: RedisRooms,
  app: ReturnType<typeof createGateway>;
beforeAll(async () => {
  await store.migrate();
  broker = await CommandBroker.connect(
    config.rabbitUrl,
    1,
    `messenger.test.gateway.${randomUUID()}.`,
  );
  rooms = await RedisRooms.connect(config.redisUrl);
  app = createGateway(store, broker, rooms, {
    origin: config.origin,
    production: false,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
});
afterAll(async () => {
  await app.close();
  await broker.close();
  await rooms.close();
  await pool.end();
});
test("a socket authenticates, receives a confirmed queued state, and replays a saved room event", async () => {
  const account = await store.register({
    username: `ws${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    password: "password123",
    name: "Socket tester",
    deviceId: randomUUID(),
  });
  const peer = await store.register({
    username: `ws${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    password: "password123",
    name: "Peer",
    deviceId: randomUUID(),
  });
  const conversation = await store.createConversation(account.session.user.id, {
    kind: "direct",
    title: "",
    memberIds: [peer.session.user.id],
  });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: {
      cookie: `messenger_session=${account.token}`,
      origin: config.origin,
    },
  });
  const frames: ServerFrame[] = [];
  socket.on("message", (data) =>
    frames.push(serverFrameSchema.parse(JSON.parse(data.toString()))),
  );
  const wait = async (predicate: (frame: ServerFrame) => boolean) => {
    await expect.poll(() => frames.some(predicate)).toBe(true);
    return frames.find(predicate);
  };
  try {
    await wait((frame) => frame.type === "ready");
    const room = `user:${account.session.user.id}`;
    socket.send(JSON.stringify({ type: "subscribe", room }));
    await wait((frame) => frame.type === "subscribed");
    const requestId = randomUUID();
    socket.send(
      JSON.stringify({
        type: "send",
        conversationId: conversation.id,
        requestId,
        body: "Through the socket",
      }),
    );
    await wait(
      (frame) => frame.type === "queued" && frame.requestId === requestId,
    );
    const result = await store.processCommand({
      conversationId: conversation.id,
      requestId,
      senderId: account.session.user.id,
      deviceId: account.session.deviceId,
      body: "Through the socket",
    });
    if (result.status !== "saved") throw new Error("Not saved");
    await rooms.publish(room, {
      type: "message",
      eventId: randomUUID(),
      message: result.message,
    });
    await wait(
      (frame) =>
        frame.type === "event" &&
        frame.publication.event.type === "message" &&
        frame.publication.event.message.body === "Through the socket",
    );
    await store.logout(account.token);
    const closed = new Promise<number>((resolve) =>
      socket.once("close", resolve),
    );
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await closed).toBe(1008);
  } finally {
    socket.terminate();
  }
});
