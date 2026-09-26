import pg from "pg";
import { Store } from "./db/index.js";

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://messenger:messenger@localhost:55432/messenger",
});
const store = new Store(pool);
try {
  await store.migrate();
  const users = [];
  for (const [username, name] of [
    ["alice", "Alice Morgan"],
    ["bob", "Bob Chen"],
    ["carol", "Carol Rivera"],
  ]) {
    const existing = await pool.query(
      "SELECT id,username,name FROM users WHERE username=$1",
      [username],
    );
    if (existing.rows[0]) users.push(existing.rows[0]);
    else
      users.push(
        (
          await store.register({
            username,
            name,
            password: "messenger-demo",
            deviceId: "seed-device",
          })
        ).session.user,
      );
  }
  const alice = users[0];
  const bob = users[1];
  const carol = users[2];
  if (!alice || !bob || !carol) throw new Error("Seed users unavailable");
  const direct = await store.createConversation(alice.id, {
    kind: "direct",
    title: "",
    memberIds: [bob.id],
  });
  if (!direct.lastSequence)
    await store.processCommand({
      conversationId: direct.id,
      requestId: "seed-hello-bob",
      senderId: alice.id,
      deviceId: "seed-device",
      body: "Hey Bob! Ready to catch up?",
    });
  const groupRows = await pool.query(
    "SELECT id FROM conversations WHERE kind='group' AND title='Weekend plans' LIMIT 1",
  );
  const group = groupRows.rows[0]
    ? await store.conversation(alice.id, groupRows.rows[0].id)
    : await store.createConversation(alice.id, {
        kind: "group",
        title: "Weekend plans",
        memberIds: [bob.id, carol.id],
      });
  if (group && !group.lastSequence)
    await store.processCommand({
      conversationId: group.id,
      requestId: "seed-weekend",
      senderId: alice.id,
      deviceId: "seed-device",
      body: "Any plans for Saturday?",
    });
  console.log("Seeded alice, bob, carol with password messenger-demo");
} finally {
  await pool.end();
}
