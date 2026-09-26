import { describe, expect, it } from "vitest";
import {
  applyMessage,
  applyQueued,
  applyRejected,
  applyRetryable,
  retryPending,
  createPending,
  type ConversationState,
} from "./message-state";
import type { Message } from "@messenger/contracts";

const saved: Message = {
  id: "m1",
  conversationId: "c1",
  sequence: 1,
  senderId: "u1",
  requestId: "r1",
  body: "Hello",
  createdAt: "2026-01-01T00:00:00Z",
};
const empty: ConversationState = {
  messages: [],
  lastAppliedSequence: 0,
  pending: [],
  buffered: [],
};

describe("conversation state", () => {
  it("keeps one request through queued, saved, and a late queued frame", () => {
    const sent = createPending(empty, "c1", "r1", "Hello");
    const queued = applyQueued(sent, "r1");
    const applied = applyMessage(queued, saved);
    expect(applied.pending).toEqual([]);
    expect(applied.messages).toEqual([saved]);
    expect(applyQueued(applied, "r1")).toEqual(applied);
  });

  it("keeps an optimistic send visible while its saved message waits behind a gap", () => {
    const second = { ...saved, id: "m2", sequence: 2 };
    const pending = createPending(empty, "c1", "r1", "Hello");
    const gap = applyMessage(pending, second);
    expect(gap.pending).toHaveLength(1);
    const recovered = applyMessage(gap, {
      ...saved,
      id: "m0",
      requestId: "r0",
    });
    expect(recovered.pending).toEqual([]);
    expect(recovered.messages.map((message) => message.sequence)).toEqual([
      1, 2,
    ]);
  });

  it("holds an out-of-order message until the missing sequence arrives", () => {
    const second = { ...saved, id: "m2", sequence: 2, requestId: "r2" };
    const gap = applyMessage(empty, second);
    expect(gap.lastAppliedSequence).toBe(0);
    expect(gap.messages).toEqual([]);
    const recovered = applyMessage(gap, saved);
    expect(recovered.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(recovered.lastAppliedSequence).toBe(2);
    expect(applyMessage(recovered, second)).toEqual(recovered);
  });

  it("keeps an uncertain send open to a later saved result", () => {
    const pending = createPending(empty, "c1", "r1", "Hello");
    const uncertain = applyRetryable(pending, "r1", "Queue confirm timed out");
    expect(retryPending(uncertain, "r1").pending[0]).toMatchObject({
      requestId: "r1",
      status: "sending",
    });
    const savedState = applyMessage(uncertain, saved);
    expect(savedState.pending).toEqual([]);
    expect(applyQueued(savedState, "r1")).toEqual(savedState);
  });

  it("keeps a permanently rejected request terminal", () => {
    const pending = createPending(empty, "c1", "r1", "Hello");
    const rejected = applyRejected(pending, "r1", "Membership revoked");
    expect(retryPending(rejected, "r1")).toEqual(rejected);
    expect(rejected.pending).toEqual([
      {
        conversationId: "c1",
        requestId: "r1",
        body: "Hello",
        status: "rejected",
        reason: "Membership revoked",
      },
    ]);
  });
});
