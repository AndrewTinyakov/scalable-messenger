import { createHash } from "node:crypto";
import Redis from "ioredis";
import { ulid } from "ulid";
import {
  cursorSchema,
  publicationSchema,
  roomEventSchema,
  type Publication,
  type RoomCursor,
  type RoomEvent,
} from "@messenger/contracts";

const ROOM_PATTERN = /^(?:user|group):[a-zA-Z0-9_-]{1,100}$/;
const HISTORY_LIMIT = 1_000;

// All keys and the sharded channel use one hash tag, so the script works in Redis Cluster.
function keys(room: string): [string, string, string] {
  if (!ROOM_PATTERN.test(room)) throw new Error(`Invalid room: ${room}`);
  return [
    `room:{${room}}:events`,
    `room:{${room}}:epoch`,
    `room:{${room}}:live`,
  ];
}

const PUBLISH_SCRIPT = `
local stream, epochKey, channel = KEYS[1], KEYS[2], KEYS[3]
local streamType = redis.call('TYPE', stream).ok
local epochType = redis.call('TYPE', epochKey).ok
if streamType ~= 'none' and streamType ~= 'stream' then return redis.error_reply('wrong stream key type') end
if epochType ~= 'none' and epochType ~= 'string' then return redis.error_reply('wrong epoch key type') end
local epoch = redis.call('GET', epochKey)
if not epoch or redis.call('XLEN', stream) == 0 then
  epoch = ARGV[1]
  redis.call('SET', epochKey, epoch)
end
local id = redis.call('XADD', stream, 'MAXLEN', '~', ARGV[2], '*', 'event', ARGV[3])
local publication = cjson.encode({room=ARGV[4], cursor={epoch=epoch, streamId=id}, event=cjson.decode(ARGV[3])})
redis.call('SPUBLISH', channel, publication)
return publication
`;

const REPLAY_SCRIPT = `
local stream, epochKey = KEYS[1], KEYS[2]
local epoch = redis.call('GET', epochKey)
if not epoch then return {0} end
if ARGV[1] ~= '' then
  if ARGV[1] ~= epoch then return {0} end
  local prior = redis.call('XRANGE', stream, ARGV[2], ARGV[2])
  if #prior ~= 1 then return {0} end
end
local start = ARGV[2] == '' and '-' or '(' .. ARGV[2]
local entries = redis.call('XRANGE', stream, start, '+', 'COUNT', ARGV[3])
return {1, epoch, entries}
`;

function parsePublication(value: string): Publication {
  return publicationSchema.parse(JSON.parse(value));
}

export class RedisRooms {
  private readonly subscribers = new Map<
    string,
    Set<(publication: Publication) => void>
  >();
  private readonly pendingSubscriptions = new Map<string, Promise<unknown>>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly reconnectHandlers = new Set<() => void>();

  private constructor(
    private readonly writer: Redis,
    private readonly reader: Redis,
  ) {
    reader.on("smessage", (channel: string, value: string) => {
      let publication: Publication;
      try {
        publication = parsePublication(value);
      } catch (error) {
        console.error("Invalid room publication:", error);
        return;
      }
      const room = publication.room;
      if (channel !== keys(room)[2]) return;
      for (const handler of this.subscribers.get(room) ?? [])
        handler(publication);
    });
    reader.on("end", () => {
      for (const handler of this.disconnectHandlers) handler();
    });
    reader.on("reconnecting", () => {
      for (const handler of this.disconnectHandlers) handler();
    });
    reader.on("ready", () => {
      // Confirm room subscriptions before asking gateways to replay their gaps.
      void Promise.all(
        [...this.subscribers.keys()].map((room) =>
          reader.ssubscribe(keys(room)[2]),
        ),
      )
        .then(() => {
          for (const handler of this.reconnectHandlers) handler();
        })
        .catch((error) =>
          console.error("Redis room resubscription failed:", error),
        );
    });
  }

  static async connect(url: string): Promise<RedisRooms> {
    const writer = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    const reader = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await Promise.all([writer.connect(), reader.connect()]);
      return new RedisRooms(writer, reader);
    } catch (error) {
      writer.disconnect();
      reader.disconnect();
      throw error;
    }
  }

  async publish(room: string, input: RoomEvent): Promise<Publication> {
    const event = roomEventSchema.parse(input);
    const [stream, epoch, channel] = keys(room);
    const result = await this.writer.eval(
      PUBLISH_SCRIPT,
      3,
      stream,
      epoch,
      channel,
      ulid(),
      String(HISTORY_LIMIT),
      JSON.stringify(event),
      room,
    );
    if (typeof result !== "string")
      throw new Error("Unexpected Redis publication response");
    return parsePublication(result);
  }

  async subscribe(
    room: string,
    handler: (publication: Publication) => void,
  ): Promise<() => Promise<void>> {
    const channel = keys(room)[2];
    let handlers = this.subscribers.get(room);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(room, handlers);
      this.pendingSubscriptions.set(room, this.reader.ssubscribe(channel));
    }
    handlers.add(handler);
    try {
      await this.pendingSubscriptions.get(room);
    } catch (error) {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscribers.delete(room);
      this.pendingSubscriptions.delete(room);
      throw error;
    }
    return async () => {
      const current = this.subscribers.get(room);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.subscribers.delete(room);
        this.pendingSubscriptions.delete(room);
        await this.reader.sunsubscribe(channel);
      }
    };
  }

  async replay(
    room: string,
    input?: RoomCursor,
  ): Promise<{ recovered: boolean; publications: Publication[] }> {
    if (!input) return { recovered: false, publications: [] };
    const cursor = input ? cursorSchema.parse(input) : undefined;
    const [stream, epoch] = keys(room);
    const result = await this.writer.eval(
      REPLAY_SCRIPT,
      2,
      stream,
      epoch,
      cursor?.epoch ?? "",
      cursor?.streamId ?? "",
      String(HISTORY_LIMIT + 1),
    );
    if (!Array.isArray(result) || result[0] !== 1)
      return { recovered: false, publications: [] };
    const rawEpoch = result[1];
    const entries = result[2];
    if (
      typeof rawEpoch !== "string" ||
      !Array.isArray(entries) ||
      entries.length > HISTORY_LIMIT
    )
      return { recovered: false, publications: [] };
    const publications = entries.map((entry): Publication => {
      if (
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        !Array.isArray(entry[1])
      )
        throw new Error("Invalid Redis stream entry");
      const fields = entry[1] as unknown[];
      const eventIndex = fields.indexOf("event");
      if (eventIndex < 0 || typeof fields[eventIndex + 1] !== "string")
        throw new Error("Missing stream event");
      return publicationSchema.parse({
        room,
        cursor: { epoch: rawEpoch, streamId: entry[0] },
        event: JSON.parse(fields[eventIndex + 1] as string),
      });
    });
    return { recovered: true, publications };
  }

  async tail(room: string): Promise<RoomCursor | null> {
    const [stream, epochKey] = keys(room);
    const [epoch, entries] = await Promise.all([
      this.writer.get(epochKey),
      this.writer.xrevrange(stream, "+", "-", "COUNT", 1),
    ]);
    const id = entries[0]?.[0];
    return epoch && id ? cursorSchema.parse({ epoch, streamId: id }) : null;
  }

  async rateLimit(userId: string): Promise<boolean> {
    if (userId.length < 1 || userId.length > 200)
      throw new Error("Invalid rate limit subject");
    const subject = createHash("sha256").update(userId).digest("hex");
    const count = await this.writer.eval(
      `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],10) end; return n`,
      1,
      `send-rate:{${subject}}`,
    );
    return typeof count === "number" && count <= 20;
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.reader.quit(), this.writer.quit()]);
  }
}
