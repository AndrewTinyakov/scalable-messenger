import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { RedisRooms } from "./rooms.js";

describe("Redis room publication and replay", () => {
  it("publishes to subscribers and replays only when the prior cursor is retained", async () => {
    const rooms = await RedisRooms.connect(
      process.env.REDIS_URL ?? "redis://localhost:6380",
    );
    const room = `user:${ulid()}`;
    const seen: string[] = [];
    const unsubscribe = await rooms.subscribe(room, (publication) =>
      seen.push(publication.event.eventId),
    );
    try {
      const first = await rooms.publish(room, {
        type: "conversations_changed",
        eventId: ulid(),
      });
      const second = await rooms.publish(room, {
        type: "conversations_changed",
        eventId: ulid(),
      });
      await expect.poll(() => seen.length).toBe(2);
      expect(seen).toEqual([first.event.eventId, second.event.eventId]);
      expect(await rooms.replay(room, first.cursor)).toEqual({
        recovered: true,
        publications: [second],
      });
      expect(await rooms.replay(room)).toEqual({
        recovered: false,
        publications: [],
      });
      expect(await rooms.tail(room)).toEqual(second.cursor);
      expect(
        await rooms.replay(room, { ...first.cursor, epoch: "old" }),
      ).toEqual({ recovered: false, publications: [] });
      expect(
        await rooms.replay(room, { ...first.cursor, streamId: "1-0" }),
      ).toEqual({ recovered: false, publications: [] });
    } finally {
      await unsubscribe();
      await rooms.close();
    }
  });

  it("shares a rate limit for an IP-based subject", async () => {
    const rooms = await RedisRooms.connect(
      process.env.REDIS_URL ?? "redis://localhost:6380",
    );
    try {
      expect(await rooms.rateLimit(`auth:2001:db8::${ulid()}`)).toBe(true);
    } finally {
      await rooms.close();
    }
  });
});
