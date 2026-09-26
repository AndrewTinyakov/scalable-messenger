import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { Store } from "../src/db/index.js";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://messenger:messenger@localhost:55432/messenger",
});
const store = new Store(pool);
const suffix = Date.now().toString(36);

beforeAll(() => store.migrate());
afterAll(() => pool.end());

test("a confirmed command has one durable result and one conversation sequence across retries", async () => {
  const alice = (
    await store.register({
      username: `alice_${suffix}`,
      name: "Alice",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const bob = (
    await store.register({
      username: `bob_${suffix}`,
      name: "Bob",
      password: "test-password",
      deviceId: "tablet",
    })
  ).session.user;
  const conversation = await store.createConversation(alice.id, {
    kind: "direct",
    memberIds: [bob.id],
  });
  const command = {
    conversationId: conversation.id,
    senderId: alice.id,
    deviceId: "phone",
    requestId: `request_${suffix}`,
    body: "Hello Bob",
  };

  const [first, retry] = await Promise.all([
    store.processCommand(command),
    store.processCommand(command),
  ]);
  expect(first.status).toBe("saved");
  expect(retry).toEqual(first);
  expect(
    await store.sendStatus(alice.id, conversation.id, command.requestId),
  ).toEqual(first);
  expect(
    await store.sendStatus(bob.id, conversation.id, command.requestId),
  ).toEqual({ status: "unknown" });
  const history = await store.history(bob.id, conversation.id, 0, 20);
  expect(
    history.messages.map((message) => [message.sequence, message.body]),
  ).toEqual([[1, "Hello Bob"]]);
  expect(history.nextSequence).toBe(1);
  expect(history.hasMore).toBe(false);
});

test("membership revocation blocks new sends and history, with a durable rejection", async () => {
  const owner = (
    await store.register({
      username: `owner_${suffix}`,
      name: "Owner",
      password: "test-password",
      deviceId: "desktop",
    })
  ).session.user;
  const member = (
    await store.register({
      username: `member_${suffix}`,
      name: "Member",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const group = await store.createConversation(owner.id, {
    kind: "group",
    title: "Test group",
    memberIds: [member.id],
  });
  await store.removeMember(owner.id, group.id, member.id);

  expect(await store.authorizeRoom(member.id, `group:${group.id}`)).toBe(false);
  await expect(store.history(member.id, group.id, 0, 20)).rejects.toMatchObject(
    { statusCode: 403 },
  );
  const result = await store.processCommand({
    conversationId: group.id,
    senderId: member.id,
    deviceId: "phone",
    requestId: `removed_${suffix}`,
    body: "Can I send?",
  });
  expect(result).toEqual({ status: "rejected", reason: "not_a_member" });
  expect(
    await store.sendStatus(member.id, group.id, `removed_${suffix}`),
  ).toEqual(result);
});

test("device applied position cannot pass the saved conversation tail", async () => {
  const alice = (
    await store.register({
      username: `ack_${suffix}`,
      name: "Ack User",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const bob = (
    await store.register({
      username: `ack_peer_${suffix}`,
      name: "Ack Peer",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const conversation = await store.createConversation(alice.id, {
    kind: "direct",
    memberIds: [bob.id],
  });
  await expect(
    store.applied(alice.id, "phone", conversation.id, 1),
  ).rejects.toMatchObject({ statusCode: 400, code: "invalid_sequence" });
  await store.applied(alice.id, "phone", conversation.id, 0);
  await store.processCommand({
    conversationId: conversation.id,
    senderId: alice.id,
    deviceId: "phone",
    requestId: `ack_send_${suffix}`,
    body: "One",
  });
  await store.applied(alice.id, "phone", conversation.id, 1);
  await expect(
    store.applied(alice.id, "phone", conversation.id, 2),
  ).rejects.toMatchObject({ statusCode: 400, code: "invalid_sequence" });
});

test("concurrent distinct sends preserve a contiguous conversation sequence", async () => {
  const alice = (
    await store.register({
      username: `parallel_${suffix}`,
      name: "Parallel User",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const bob = (
    await store.register({
      username: `parallel_peer_${suffix}`,
      name: "Parallel Peer",
      password: "test-password",
      deviceId: "phone",
    })
  ).session.user;
  const conversation = await store.createConversation(alice.id, {
    kind: "direct",
    memberIds: [bob.id],
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.processCommand({
        conversationId: conversation.id,
        senderId: alice.id,
        deviceId: "phone",
        requestId: `parallel_${suffix}_${index}`,
        body: `Message ${index}`,
      }),
    ),
  );
  expect(results.every((result) => result.status === "saved")).toBe(true);
  const history = await store.history(bob.id, conversation.id, 0, 20);
  expect(history.messages.map((message) => message.sequence)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});

test("outbox metrics expose pending and failed publication work", async () => {
  const before = await store.metrics();
  expect(before).toMatchObject({
    savedMessages: expect.any(Number),
    pendingOutbox: expect.any(Number),
    failedOutbox: expect.any(Number),
  });
  const claimed = await store.claimOutbox(`test-relay-${suffix}`, 1);
  expect(claimed).toHaveLength(1);
  const event = claimed[0];
  if (!event) throw new Error("Outbox should have work");
  await store.failOutbox(
    `test-relay-${suffix}`,
    event.id,
    new Error("Redis unavailable"),
  );
  const failed = await store.metrics();
  expect(failed.failedOutbox).toBeGreaterThanOrEqual(before.failedOutbox + 1);
  expect(failed.oldestPendingSeconds).toEqual(expect.any(Number));
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const retried = await store.claimOutbox(`test-relay-${suffix}`, 100);
  expect(retried.some((row) => row.id === event.id)).toBe(true);
  for (const row of retried)
    await store.completeOutbox(`test-relay-${suffix}`, row.id);
});
