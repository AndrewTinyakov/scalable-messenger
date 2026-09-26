import { beforeAll, afterAll, expect, test } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createApi } from "../src/api.js";
import { Store } from "../src/db/index.js";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://messenger:messenger@localhost:55432/messenger",
});
const store = new Store(pool);
const app = createApi(store, {
  origin: "http://localhost:5173",
  production: false,
});
beforeAll(async () => {
  await store.migrate();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
test("an authenticated device can create a conversation and recover saved sends without exposing history to other users", async () => {
  async function register() {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        username: `u${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        name: "Test person",
        password: "password123",
        deviceId: randomUUID(),
      },
    });
    expect(response.statusCode).toBe(201);
    return {
      session: response.json(),
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    };
  }
  const alice = await register(),
    bob = await register(),
    outsider = await register();
  const created = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers: { cookie: alice.cookie },
    payload: { kind: "direct", memberIds: [bob.session.user.id] },
  });
  expect(created.statusCode).toBe(201);
  const conversation = created.json();
  const requestId = randomUUID();
  await store.processCommand({
    conversationId: conversation.id,
    requestId,
    senderId: alice.session.user.id,
    deviceId: alice.session.deviceId,
    body: "A saved message",
  });
  const history = await app.inject({
    url: `/api/conversations/${conversation.id}/messages?afterSeq=0`,
    headers: { cookie: bob.cookie },
  });
  expect(history.json().messages).toMatchObject([
    { body: "A saved message", sequence: 1 },
  ]);
  const forbidden = await app.inject({
    url: `/api/conversations/${conversation.id}/messages`,
    headers: { cookie: outsider.cookie },
  });
  expect(forbidden.statusCode).toBe(403);
  const status = await app.inject({
    url: `/api/conversations/${conversation.id}/send-status/${requestId}`,
    headers: { cookie: alice.cookie },
  });
  expect(status.json()).toMatchObject({
    status: "saved",
    message: { sequence: 1 },
  });
  const logout = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { cookie: alice.cookie },
  });
  expect(logout.statusCode).toBe(204);
  expect(
    (
      await app.inject({
        url: "/api/auth/session",
        headers: { cookie: alice.cookie },
      })
    ).statusCode,
  ).toBe(401);
});
