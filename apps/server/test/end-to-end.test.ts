import { randomUUID } from "node:crypto";
import amqp from "amqplib";
import Redis from "ioredis";
import { Pool } from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, test } from "vitest";
import { serverFrameSchema, type ServerFrame } from "@messenger/contracts";
import { createApi } from "../src/api.js";
import { CommandBroker, RedisRooms } from "../src/brokers/index.js";
import { config } from "../src/config.js";
import { Store } from "../src/db/index.js";
import { createGateway } from "../src/gateway.js";

const testId = randomUUID().replaceAll("-", "");
const schema = `messenger_e2e_${testId}`;
const prefix = `messenger.test.e2e.${testId}.`;
const adminPool = new Pool({ connectionString: config.databaseUrl });
const pool = new Pool({
  connectionString: config.databaseUrl,
  options: `-c search_path=${schema}`,
});
const store = new Store(pool);
const api = createApi(store, { origin: config.origin, production: false });
let broker: CommandBroker;
let roomsA: RedisRooms;
let roomsB: RedisRooms;
let relayRooms: RedisRooms;
let gatewayA: ReturnType<typeof createGateway>;
let gatewayB: ReturnType<typeof createGateway>;
let relayTimer: ReturnType<typeof setInterval>;
let relayWork: Promise<void> = Promise.resolve();
let relaying = false;
let relayError: unknown = null;
const processedRequests = new Map<string, number>();
const sockets: WebSocket[] = [];
const usedRooms = new Set<string>();

function portOf(app: {
  server: { address(): string | { port: number } | null };
}): number {
  const address = app.server.address();
  if (!address || typeof address === "string")
    throw new Error("Server has no port");
  return address.port;
}

async function relayOnce(): Promise<void> {
  const batch = await store.claimOutbox(testId, 100);
  for (const row of batch) {
    usedRooms.add(row.room);
    try {
      await relayRooms.publish(row.room, row.event);
      await store.completeOutbox(testId, row.id);
    } catch (error) {
      await store.failOutbox(testId, row.id, error);
      throw error;
    }
  }
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  await expect
    .poll(check, { timeout: 8_000, interval: 25, message: label })
    .toBe(true);
}

type SocketView = {
  socket: WebSocket;
  frames: ServerFrame[];
  wait: (
    predicate: (frame: ServerFrame) => boolean,
    label: string,
  ) => Promise<ServerFrame>;
  send: (frame: object) => void;
  close: () => Promise<number>;
};
async function connect(
  gateway: ReturnType<typeof createGateway>,
  cookie: string,
): Promise<SocketView> {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(gateway)}/ws`, {
    headers: { cookie, origin: config.origin },
  });
  sockets.push(socket);
  const frames: ServerFrame[] = [];
  socket.on("message", (data) =>
    frames.push(serverFrameSchema.parse(JSON.parse(data.toString()))),
  );
  const wait = async (
    predicate: (frame: ServerFrame) => boolean,
    label: string,
  ) => {
    await waitUntil(() => frames.some(predicate), label);
    const frame = frames.find(predicate);
    if (!frame) throw new Error(`Missing ${label}`);
    return frame;
  };
  await wait((frame) => frame.type === "ready", "socket ready");
  return {
    socket,
    frames,
    wait,
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return 1000;
      const closed = new Promise<number>((resolve) =>
        socket.once("close", resolve),
      );
      socket.close();
      return closed;
    },
  };
}

async function subscribe(view: SocketView, room: string): Promise<void> {
  usedRooms.add(room);
  view.send({ type: "subscribe", room });
  await view.wait(
    (frame) => frame.type === "subscribed" && frame.room === room,
    `subscribed ${room}`,
  );
}

async function register(username: string, name: string, deviceId: string) {
  const response = await api.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username, name, password: "password123", deviceId },
  });
  expect(response.statusCode).toBe(201);
  return {
    session: response.json() as { user: { id: string }; deviceId: string },
    cookie: response.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
  };
}

async function request(
  cookie: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: object,
) {
  return api.inject({ method, url, headers: { cookie }, payload });
}

beforeAll(async () => {
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  await store.migrate();
  broker = await CommandBroker.connect(config.rabbitUrl, 1, prefix);
  roomsA = await RedisRooms.connect(config.redisUrl);
  roomsB = await RedisRooms.connect(config.redisUrl);
  relayRooms = await RedisRooms.connect(config.redisUrl);
  gatewayA = createGateway(store, broker, roomsA, {
    origin: config.origin,
    production: false,
  });
  gatewayB = createGateway(store, broker, roomsB, {
    origin: config.origin,
    production: false,
  });
  await Promise.all([
    api.listen({ port: 0, host: "127.0.0.1" }),
    gatewayA.listen({ port: 0, host: "127.0.0.1" }),
    gatewayB.listen({ port: 0, host: "127.0.0.1" }),
  ]);
  await broker.consume(async (command) => {
    await store.processCommand(command);
    processedRequests.set(
      command.requestId,
      (processedRequests.get(command.requestId) ?? 0) + 1,
    );
  });
  relayTimer = setInterval(() => {
    if (relaying) return;
    relaying = true;
    relayWork = relayOnce()
      .catch((error) => {
        relayError = error;
      })
      .finally(() => {
        relaying = false;
      });
  }, 25);
}, 30_000);

afterAll(async () => {
  if (relayTimer) clearInterval(relayTimer);
  await relayWork.catch(() => undefined);
  for (const socket of sockets) socket.terminate();
  await Promise.allSettled([api.close(), gatewayA?.close(), gatewayB?.close()]);
  await Promise.allSettled([
    broker?.close(),
    roomsA?.close(),
    roomsB?.close(),
    relayRooms?.close(),
  ]);
  const redis = new Redis(config.redisUrl);
  const keys = [...usedRooms].flatMap((room) => [
    `room:{${room}}:events`,
    `room:{${room}}:epoch`,
  ]);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
  const connection = await amqp.connect(config.rabbitUrl);
  const channel = await connection.createChannel();
  await channel.deleteQueue(`${prefix}0`);
  await channel.deleteQueue(`${prefix}quarantine`);
  await channel.close();
  await connection.close();
  await pool.end();
  await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  await adminPool.end();
}, 30_000);

test("confirmed commands cross gateway nodes and recover through SQL after a disconnect", async () => {
  const alice = await register(
    `a${testId.slice(0, 20)}`,
    "Alice",
    "alice-phone",
  );
  const bob = await register(`b${testId.slice(0, 20)}`, "Bob", "bob-phone");
  const carol = await register(
    `c${testId.slice(0, 20)}`,
    "Carol",
    "carol-phone",
  );
  const login = await request(alice.cookie, "POST", "/api/auth/login", {
    username: `a${testId.slice(0, 20)}`,
    password: "password123",
    deviceId: "alice-laptop",
  });
  expect(login.statusCode).toBe(200);
  const aliceLaptopCookie = login.cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const directResponse = await request(
    alice.cookie,
    "POST",
    "/api/conversations",
    { kind: "direct", memberIds: [bob.session.user.id] },
  );
  expect(directResponse.statusCode).toBe(201);
  const direct = directResponse.json() as { id: string };
  const alicePhone = await connect(gatewayA, alice.cookie);
  const aliceLaptop = await connect(gatewayB, aliceLaptopCookie);
  let bobPhone = await connect(gatewayB, bob.cookie);
  const aliceRoom = `user:${alice.session.user.id}`;
  const bobRoom = `user:${bob.session.user.id}`;
  await Promise.all([
    subscribe(alicePhone, aliceRoom),
    subscribe(aliceLaptop, aliceRoom),
    subscribe(bobPhone, bobRoom),
  ]);

  const requestId = `first_${testId}`;
  alicePhone.send({
    type: "send",
    conversationId: direct.id,
    requestId,
    body: "Across two nodes",
  });
  await alicePhone.wait(
    (frame) => frame.type === "queued" && frame.requestId === requestId,
    "first command confirmed",
  );
  const messageEvent = (frame: ServerFrame) =>
    frame.type === "event" &&
    frame.publication.event.type === "message" &&
    frame.publication.event.message.requestId === requestId;
  await bobPhone.wait(messageEvent, "Bob received first message");
  await aliceLaptop.wait(
    messageEvent,
    "Alice's second device received first message",
  );
  const status = await request(
    alice.cookie,
    "GET",
    `/api/conversations/${direct.id}/send-status/${requestId}`,
  );
  expect(status.json()).toMatchObject({
    status: "saved",
    message: { sequence: 1, body: "Across two nodes" },
  });

  alicePhone.send({
    type: "send",
    conversationId: direct.id,
    requestId,
    body: "Across two nodes",
  });
  await waitUntil(
    () =>
      alicePhone.frames.filter(
        (frame) => frame.type === "queued" && frame.requestId === requestId,
      ).length >= 2,
    "duplicate command confirmed",
  );
  await waitUntil(
    () => processedRequests.get(requestId) === 2,
    "duplicate command processed",
  );
  const once = await request(
    bob.cookie,
    "GET",
    `/api/conversations/${direct.id}/messages?afterSeq=0`,
  );
  expect(once.json().messages).toMatchObject([{ sequence: 1, requestId }]);

  await bobPhone.close();
  const secondId = `second_${testId}`;
  alicePhone.send({
    type: "send",
    conversationId: direct.id,
    requestId: secondId,
    body: "While you were away",
  });
  await aliceLaptop.wait(
    (frame) =>
      frame.type === "event" &&
      frame.publication.event.type === "message" &&
      frame.publication.event.message.requestId === secondId,
    "second message saved",
  );
  bobPhone = await connect(gatewayB, bob.cookie);
  await subscribe(bobPhone, bobRoom);
  await bobPhone.wait(
    (frame) => frame.type === "recovery_failed" && frame.room === bobRoom,
    "SQL recovery requested",
  );
  const recovered = await request(
    bob.cookie,
    "GET",
    `/api/conversations/${direct.id}/messages?afterSeq=1`,
  );
  expect(recovered.json()).toMatchObject({
    messages: [{ sequence: 2, body: "While you were away" }],
    nextSequence: 2,
    hasMore: false,
  });

  const groupResponse = await request(
    alice.cookie,
    "POST",
    "/api/conversations",
    {
      kind: "group",
      title: "Test group",
      memberIds: [bob.session.user.id, carol.session.user.id],
    },
  );
  expect(groupResponse.statusCode).toBe(201);
  const group = groupResponse.json() as { id: string };
  const groupRoom = `group:${group.id}`;
  const carolPhone = await connect(gatewayA, carol.cookie);
  await Promise.all([
    subscribe(alicePhone, groupRoom),
    subscribe(bobPhone, groupRoom),
    subscribe(carolPhone, groupRoom),
  ]);
  const beforeRevoke = `group_before_${testId}`;
  alicePhone.send({
    type: "send",
    conversationId: group.id,
    requestId: beforeRevoke,
    body: "Group hello",
  });
  await bobPhone.wait(
    (frame) =>
      frame.type === "event" &&
      frame.publication.event.type === "message" &&
      frame.publication.event.message.requestId === beforeRevoke,
    "Bob received group message",
  );
  const removal = await request(
    alice.cookie,
    "DELETE",
    `/api/conversations/${group.id}/members/${bob.session.user.id}`,
  );
  expect(removal.statusCode).toBe(204);
  const afterRevoke = `group_after_${testId}`;
  alicePhone.send({
    type: "send",
    conversationId: group.id,
    requestId: afterRevoke,
    body: "Private after removal",
  });
  await carolPhone.wait(
    (frame) =>
      frame.type === "event" &&
      frame.publication.event.type === "message" &&
      frame.publication.event.message.requestId === afterRevoke,
    "Carol received post-removal message",
  );
  await waitUntil(
    () => bobPhone.socket.readyState === WebSocket.CLOSED,
    "revoked group socket closed",
  );
  expect(
    bobPhone.frames.some(
      (frame) =>
        frame.type === "event" &&
        frame.publication.event.type === "message" &&
        frame.publication.event.message.requestId === afterRevoke,
    ),
  ).toBe(false);
  const forbidden = await request(
    bob.cookie,
    "GET",
    `/api/conversations/${group.id}/messages?afterSeq=0`,
  );
  expect(forbidden.statusCode).toBe(403);
  const bobAgain = await connect(gatewayB, bob.cookie);
  await subscribe(bobAgain, bobRoom);
  const deniedId = `denied_${testId}`;
  bobAgain.send({
    type: "send",
    conversationId: group.id,
    requestId: deniedId,
    body: "No longer a member",
  });
  await bobAgain.wait(
    (frame) => frame.type === "queued" && frame.requestId === deniedId,
    "removed user's command confirmed",
  );
  await bobAgain.wait(
    (frame) =>
      frame.type === "event" &&
      frame.publication.event.type === "rejected" &&
      frame.publication.event.requestId === deniedId,
    "removed user's command rejected",
  );
  const denied = await request(
    bob.cookie,
    "GET",
    `/api/conversations/${group.id}/send-status/${deniedId}`,
  );
  expect(denied.json()).toEqual({ status: "rejected", reason: "not_a_member" });
  expect(relayError).toBeNull();
}, 20_000);
