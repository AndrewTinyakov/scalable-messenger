import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import {
  commandSchema,
  createConversationSchema,
  credentialsSchema,
  registerSchema,
  type Conversation,
  type Message,
  type RoomEvent,
  type SendCommand,
  type SendResult,
  type Session,
  type User,
} from "@messenger/contracts";
import { schema } from "./schema.js";

const scrypt = promisify(scryptCallback);
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const userRow = (row: Record<string, unknown>): User => ({
  id: String(row.id),
  username: String(row.username),
  name: String(row.name),
});
const messageRow = (row: Record<string, unknown>): Message => ({
  id: String(row.id),
  conversationId: String(row.conversation_id),
  sequence: Number(row.sequence),
  senderId: String(row.sender_id),
  requestId: String(row.request_id),
  body: String(row.body),
  createdAt: new Date(String(row.created_at)).toISOString(),
});
const ID = () => ulid();

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}
async function checkPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex || hex.length !== 128) return false;
  const expected = Buffer.from(hex, "hex");
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(expected, actual);
}

export class Store {
  constructor(private readonly pool: Pool) {}
  async migrate(): Promise<void> {
    await this.transact(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(713019)");
      await client.query(schema);
    });
  }

  private async transact<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async register(input: unknown): Promise<{ token: string; session: Session }> {
    const data = registerSchema.parse(input);
    const hash = await hashPassword(data.password);
    const id = ID();
    try {
      await this.pool.query(
        "INSERT INTO users(id,username,name,password_hash) VALUES($1,$2,$3,$4)",
        [id, data.username, data.name, hash],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new StoreError(
          "Username is already taken",
          409,
          "username_taken",
        );
      throw error;
    }
    return this.createSession(
      { id, username: data.username, name: data.name },
      data.deviceId,
    );
  }

  async login(input: unknown): Promise<{ token: string; session: Session }> {
    const data = credentialsSchema.parse(input);
    const result = await this.pool.query(
      "SELECT id, username, name, password_hash FROM users WHERE username=$1",
      [data.username],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      !(await checkPassword(data.password, String(row.password_hash)))
    )
      throw new StoreError("Invalid credentials", 401, "invalid_credentials");
    return this.createSession(userRow(row), data.deviceId);
  }

  private async createSession(
    user: User,
    deviceId: string,
  ): Promise<{ token: string; session: Session }> {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES($1,$2,$3,now() + interval '30 days')",
      [tokenHash(token), user.id, deviceId],
    );
    return { token, session: { user, deviceId } };
  }
  async session(token: string): Promise<Session | null> {
    const result = await this.pool.query(
      "SELECT u.id,u.username,u.name,s.device_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [tokenHash(token)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? { user: userRow(row), deviceId: String(row.device_id) } : null;
  }
  async logout(token: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash=$1", [
      tokenHash(token),
    ]);
  }
  async users(search: string, currentUserId: string): Promise<User[]> {
    const result = await this.pool.query(
      "SELECT id,username,name FROM users WHERE id<>$1 AND (username ILIKE $2 OR name ILIKE $2) ORDER BY username LIMIT 30",
      [currentUserId, `%${search.replace(/[\\%_]/g, "\\$&")}%`],
    );
    return result.rows.map(userRow);
  }

  private async conversationWith(
    client: Pool | PoolClient,
    id: string,
    userId: string,
  ): Promise<Conversation | null> {
    const result = await client.query(
      "SELECT c.id,c.kind,c.title,c.last_sequence FROM conversations c JOIN memberships self ON self.conversation_id=c.id AND self.user_id=$2 AND self.active=true WHERE c.id=$1",
      [id, userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const membersResult = await client.query(
      "SELECT u.id,u.username,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.active=true ORDER BY u.username",
      [id],
    );
    const last = await client.query(
      "SELECT id,conversation_id,sequence,sender_id,request_id,body,created_at FROM messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 1",
      [id],
    );
    return {
      id,
      kind: row.kind as "direct" | "group",
      title: String(row.title),
      members: membersResult.rows.map(userRow),
      lastSequence: Number(row.last_sequence),
      lastMessage: last.rows[0] ? messageRow(last.rows[0]) : null,
    };
  }
  async conversation(userId: string, id: string): Promise<Conversation | null> {
    return this.conversationWith(this.pool, id, userId);
  }
  async conversations(userId: string): Promise<Conversation[]> {
    const ids = await this.pool.query(
      "SELECT c.id FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE m.user_id=$1 AND m.active=true ORDER BY c.created_at DESC",
      [userId],
    );
    const items = await Promise.all(
      ids.rows.map((row: { id: string }) => this.conversation(userId, row.id)),
    );
    return items.filter((item): item is Conversation => item !== null);
  }

  async createConversation(
    userId: string,
    input: unknown,
  ): Promise<Conversation> {
    const data = createConversationSchema.parse(input);
    const memberIds = [...new Set([userId, ...data.memberIds])];
    if (data.kind === "direct" && memberIds.length !== 2)
      throw new StoreError(
        "A direct conversation needs exactly two members",
        400,
        "invalid_members",
      );
    if (data.kind === "group" && memberIds.length < 2)
      throw new StoreError(
        "A group needs at least two members",
        400,
        "invalid_members",
      );
    const existingUsers = await this.pool.query(
      "SELECT id FROM users WHERE id=ANY($1::text[])",
      [memberIds],
    );
    if (existingUsers.rowCount !== memberIds.length)
      throw new StoreError("Unknown member", 400, "unknown_member");
    const directKey =
      data.kind === "direct" ? memberIds.sort().join(":") : null;
    const id = ID();
    return this.transact(async (client) => {
      const created = await client.query(
        "INSERT INTO conversations(id,kind,title,owner_id,direct_key) VALUES($1,$2,$3,$4,$5) ON CONFLICT (direct_key) DO NOTHING RETURNING id",
        [id, data.kind, data.title, userId, directKey],
      );
      const conversationId = created.rows[0]?.id as string | undefined;
      if (!conversationId && directKey) {
        const existing = await client.query(
          "SELECT id FROM conversations WHERE direct_key=$1",
          [directKey],
        );
        const previous = await this.conversationWith(
          client,
          String(existing.rows[0]?.id),
          userId,
        );
        if (previous) return previous;
        throw new StoreError("Conversation is unavailable", 403, "forbidden");
      }
      if (!conversationId) throw new Error("Conversation insert failed");
      for (const memberId of memberIds) {
        await client.query(
          "INSERT INTO memberships(conversation_id,user_id) VALUES($1,$2)",
          [conversationId, memberId],
        );
        await this.insertOutbox(client, `user:${memberId}`, {
          type: "conversations_changed",
          eventId: ID(),
        });
      }
      await client.query("SELECT pg_notify('outbox_changed',$1)", [
        conversationId,
      ]);
      const conversation = await this.conversationWith(
        client,
        conversationId,
        userId,
      );
      if (!conversation) throw new Error("New conversation unavailable");
      return conversation;
    });
  }

  async history(
    userId: string,
    id: string,
    after = 0,
    limit = 50,
  ): Promise<{ messages: Message[]; nextSequence: number; hasMore: boolean }> {
    if (!(await this.authorizeConversation(userId, id)))
      throw new StoreError("Forbidden", 403, "forbidden");
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const result = await this.pool.query(
      "SELECT id,conversation_id,sequence,sender_id,request_id,body,created_at FROM messages WHERE conversation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3",
      [id, Math.max(0, after), safeLimit + 1],
    );
    const hasMore = result.rows.length > safeLimit;
    const messages = result.rows.slice(0, safeLimit).map(messageRow);
    return {
      messages,
      nextSequence: messages.at(-1)?.sequence ?? Math.max(0, after),
      hasMore,
    };
  }

  async sendStatus(
    userId: string,
    conversationId: string,
    requestId: string,
  ): Promise<SendResult> {
    const result = await this.pool.query(
      "SELECT r.status,r.reason,m.id,m.conversation_id,m.sequence,m.sender_id,m.request_id,m.body,m.created_at FROM send_requests r LEFT JOIN messages m ON m.id=r.message_id WHERE r.conversation_id=$1 AND r.sender_id=$2 AND r.request_id=$3",
      [conversationId, userId, requestId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.status === "processing") return { status: "unknown" };
    if (row.status === "rejected")
      return { status: "rejected", reason: String(row.reason) };
    return { status: "saved", message: messageRow(row) };
  }

  private async insertOutbox(
    client: PoolClient,
    room: string,
    event: RoomEvent,
  ): Promise<void> {
    await client.query(
      "INSERT INTO outbox(id,room,event) VALUES($1,$2,$3::jsonb)",
      [ID(), room, JSON.stringify(event)],
    );
  }

  async processCommand(input: SendCommand): Promise<SendResult> {
    const parsed = commandSchema.safeParse(input);
    const command = parsed.success ? parsed.data : input;
    return this.transact(async (client) => {
      await client.query(
        "INSERT INTO send_requests(conversation_id,sender_id,request_id,status) VALUES($1,$2,$3,'processing') ON CONFLICT DO NOTHING",
        [command.conversationId, command.senderId, command.requestId],
      );
      const existing = await client.query(
        "SELECT status,reason,message_id FROM send_requests WHERE conversation_id=$1 AND sender_id=$2 AND request_id=$3 FOR UPDATE",
        [command.conversationId, command.senderId, command.requestId],
      );
      const row = existing.rows[0] as
        | { status: string; reason: string | null; message_id: string | null }
        | undefined;
      if (!row) throw new Error("Request was not inserted");
      if (row.status === "saved" && row.message_id) {
        const saved = await client.query(
          "SELECT id,conversation_id,sequence,sender_id,request_id,body,created_at FROM messages WHERE id=$1",
          [row.message_id],
        );
        return { status: "saved", message: messageRow(saved.rows[0]) };
      }
      if (row.status === "rejected")
        return { status: "rejected", reason: String(row.reason) };
      const conversation = await client.query(
        "SELECT kind FROM conversations WHERE id=$1 FOR UPDATE",
        [command.conversationId],
      );
      const member = await client.query(
        "SELECT active FROM memberships WHERE conversation_id=$1 AND user_id=$2 FOR SHARE",
        [command.conversationId, command.senderId],
      );
      const reason = !parsed.success
        ? "invalid_message"
        : !conversation.rows[0] || member.rows[0]?.active !== true
          ? "not_a_member"
          : null;
      if (reason) {
        await client.query(
          "UPDATE send_requests SET status='rejected',reason=$4 WHERE conversation_id=$1 AND sender_id=$2 AND request_id=$3",
          [command.conversationId, command.senderId, command.requestId, reason],
        );
        await this.insertOutbox(client, `user:${command.senderId}`, {
          type: "rejected",
          eventId: ID(),
          conversationId: command.conversationId,
          requestId: command.requestId,
          reason,
        });
        await client.query("SELECT pg_notify('outbox_changed',$1)", [
          command.conversationId,
        ]);
        return { status: "rejected", reason };
      }
      const counter = await client.query(
        "UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence,kind",
        [command.conversationId],
      );
      const sequence = Number(counter.rows[0].last_sequence);
      const id = ID();
      const inserted = await client.query(
        "INSERT INTO messages(id,conversation_id,sequence,sender_id,request_id,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,conversation_id,sequence,sender_id,request_id,body,created_at",
        [
          id,
          command.conversationId,
          sequence,
          command.senderId,
          command.requestId,
          command.body.trim(),
        ],
      );
      const message = messageRow(inserted.rows[0]);
      await client.query(
        "UPDATE send_requests SET status='saved',message_id=$4 WHERE conversation_id=$1 AND sender_id=$2 AND request_id=$3",
        [command.conversationId, command.senderId, command.requestId, id],
      );
      const event: RoomEvent = { type: "message", eventId: ID(), message };
      if (counter.rows[0].kind === "group")
        await this.insertOutbox(
          client,
          `group:${command.conversationId}`,
          event,
        );
      else {
        const members = await client.query(
          "SELECT user_id FROM memberships WHERE conversation_id=$1 AND active=true",
          [command.conversationId],
        );
        for (const memberRow of members.rows)
          await this.insertOutbox(client, `user:${memberRow.user_id}`, event);
      }
      await client.query("SELECT pg_notify('outbox_changed',$1)", [
        command.conversationId,
      ]);
      return { status: "saved", message };
    });
  }

  private async authorizeConversation(
    userId: string,
    conversationId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM memberships WHERE conversation_id=$1 AND user_id=$2 AND active=true",
      [conversationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async rooms(userId: string): Promise<string[]> {
    const result = await this.pool.query(
      "SELECT c.id FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE c.kind='group' AND m.user_id=$1 AND m.active=true",
      [userId],
    );
    return [
      `user:${userId}`,
      ...result.rows.map((row: { id: string }) => `group:${row.id}`),
    ];
  }
  async authorizeRoom(userId: string, room: string): Promise<boolean> {
    if (room === `user:${userId}`) return true;
    if (!room.startsWith("group:")) return false;
    const id = room.slice(6);
    const result = await this.pool.query(
      "SELECT 1 FROM conversations c JOIN memberships m ON m.conversation_id=c.id WHERE c.id=$1 AND c.kind='group' AND m.user_id=$2 AND m.active=true",
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
  async applied(
    userId: string,
    deviceId: string,
    conversationId: string,
    sequence: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new StoreError("Invalid sequence", 400, "invalid_sequence");
    const result = await this.pool.query(
      `INSERT INTO device_positions(user_id,device_id,conversation_id,sequence)
      SELECT $1,$2,c.id,$4 FROM conversations c
      JOIN memberships m ON m.conversation_id=c.id AND m.user_id=$1 AND m.active=true
      WHERE c.id=$3 AND c.last_sequence >= $4
      ON CONFLICT (user_id,device_id,conversation_id)
      DO UPDATE SET sequence=GREATEST(device_positions.sequence,EXCLUDED.sequence),updated_at=now()`,
      [userId, deviceId, conversationId, sequence],
    );
    if (result.rowCount) return;
    if (!(await this.authorizeConversation(userId, conversationId)))
      throw new StoreError("Forbidden", 403, "forbidden");
    throw new StoreError(
      "Sequence exceeds saved history",
      400,
      "invalid_sequence",
    );
  }

  async metrics(): Promise<{
    savedMessages: number;
    pendingOutbox: number;
    oldestPendingSeconds: number | null;
    failedOutbox: number;
  }> {
    const [messages, outbox] = await Promise.all([
      this.pool.query("SELECT count(*) AS total FROM messages"),
      this.pool
        .query(`SELECT count(*) FILTER (WHERE completed_at IS NULL) AS pending,
        extract(epoch FROM now()-min(created_at) FILTER (WHERE completed_at IS NULL)) AS oldest_seconds,
        count(*) FILTER (WHERE completed_at IS NULL AND last_error IS NOT NULL) AS failed FROM outbox`),
    ]);
    const row = outbox.rows[0];
    return {
      savedMessages: Number(messages.rows[0].total),
      pendingOutbox: Number(row.pending),
      oldestPendingSeconds:
        row.oldest_seconds === null ? null : Number(row.oldest_seconds),
      failedOutbox: Number(row.failed),
    };
  }

  async removeMember(
    actorId: string,
    conversationId: string,
    memberId: string,
  ): Promise<void> {
    await this.transact(async (client) => {
      const conversation = await client.query(
        "SELECT owner_id,kind FROM conversations WHERE id=$1 FOR UPDATE",
        [conversationId],
      );
      if (!conversation.rows[0])
        throw new StoreError("Conversation not found", 404, "not_found");
      if (conversation.rows[0].owner_id !== actorId)
        throw new StoreError(
          "Only the owner can remove members",
          403,
          "forbidden",
        );
      if (conversation.rows[0].kind !== "group")
        throw new StoreError(
          "Direct conversation members cannot be removed",
          400,
          "invalid_conversation",
        );
      if (memberId === actorId)
        throw new StoreError(
          "Owner cannot remove themselves",
          400,
          "invalid_member",
        );
      const changed = await client.query(
        "UPDATE memberships SET active=false WHERE conversation_id=$1 AND user_id=$2 AND active=true RETURNING user_id",
        [conversationId, memberId],
      );
      if (!changed.rowCount)
        throw new StoreError("Member not found", 404, "not_found");
      await this.insertOutbox(client, `user:${memberId}`, {
        type: "conversations_changed",
        eventId: ID(),
      });
      const members = await client.query(
        "SELECT user_id FROM memberships WHERE conversation_id=$1 AND active=true",
        [conversationId],
      );
      for (const row of members.rows)
        await this.insertOutbox(client, `user:${row.user_id}`, {
          type: "conversations_changed",
          eventId: ID(),
        });
      await client.query("SELECT pg_notify('outbox_changed',$1)", [
        conversationId,
      ]);
    });
  }

  async claimOutbox(
    owner: string,
    limit: number,
  ): Promise<Array<{ id: string; room: string; event: RoomEvent }>> {
    return this.transact(async (client) => {
      const result = await client.query(
        `WITH claim AS (
        SELECT id FROM outbox WHERE completed_at IS NULL AND available_at<=now()
        AND (lease_until IS NULL OR lease_until<now())
        ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2
      ) UPDATE outbox o SET lease_owner=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1
        FROM claim WHERE o.id=claim.id RETURNING o.id,o.room,o.event`,
        [owner, Math.max(1, Math.min(100, limit))],
      );
      return result.rows.map(
        (row: { id: string; room: string; event: RoomEvent }) => ({
          id: row.id,
          room: row.room,
          event: row.event,
        }),
      );
    });
  }
  async completeOutbox(owner: string, id: string): Promise<void> {
    await this.pool.query(
      "UPDATE outbox SET completed_at=now(),lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL",
      [id, owner],
    );
  }
  async failOutbox(owner: string, id: string, error: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE outbox SET lease_owner=NULL,lease_until=NULL,last_error=$3,
      available_at=now() + make_interval(secs => LEAST(300,POWER(2,LEAST(attempts,8)))::integer)
      WHERE id=$1 AND lease_owner=$2 AND completed_at IS NULL`,
      [id, owner, String(error).slice(0, 1000)],
    );
  }
}
