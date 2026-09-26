import {
  cursorSchema,
  messageSchema,
  type RoomCursor,
  type Session,
} from "@messenger/contracts";
import { z } from "zod";
import type { ConversationState } from "../../../entities/message";

const pendingSchema = z.object({
  conversationId: z.string(),
  requestId: z.string(),
  body: z.string(),
  status: z.enum(["sending", "queued", "retryable", "rejected"]),
  reason: z.string().optional(),
});
const stateSchema = z.object({
  messages: z.array(messageSchema),
  lastAppliedSequence: z.number().int().nonnegative(),
  pending: z.array(pendingSchema),
});
const cacheSchema = z.object({
  states: z.record(z.string(), stateSchema),
  cursors: z.record(z.string(), cursorSchema),
});
export type MessageCache = {
  states: Record<string, ConversationState>;
  cursors: Record<string, RoomCursor>;
};
const key = (session: Session) =>
  `folio.messages.${session.user.id}.${session.deviceId}`;
export function loadCache(session: Session): MessageCache {
  try {
    const raw = localStorage.getItem(key(session));
    if (!raw) return { states: {}, cursors: {} };
    const parsed = cacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { states: {}, cursors: {} };
    const states: Record<string, ConversationState> = {};
    for (const [id, state] of Object.entries(parsed.data.states)) {
      if (
        !state.messages.every(
          (message, index) =>
            message.conversationId === id && message.sequence === index + 1,
        ) ||
        state.lastAppliedSequence !== state.messages.length ||
        !state.pending.every((item) => item.conversationId === id)
      )
        return { states: {}, cursors: {} };
      states[id] = { ...state, buffered: [] };
    }
    return { states, cursors: parsed.data.cursors };
  } catch {
    return { states: {}, cursors: {} };
  }
}
export function saveCache(session: Session, cache: MessageCache): boolean {
  try {
    localStorage.setItem(key(session), JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}
export function clearCache(session: Session) {
  try {
    localStorage.removeItem(key(session));
  } catch {
    /* Session still ends on server. */
  }
}
