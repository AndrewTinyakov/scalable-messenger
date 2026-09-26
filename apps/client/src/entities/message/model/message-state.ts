import type { Message } from "@messenger/contracts";

export type PendingSend = {
  conversationId: string;
  requestId: string;
  body: string;
  status: "sending" | "queued" | "retryable" | "rejected";
  reason?: string;
};
export type ConversationState = {
  messages: Message[];
  lastAppliedSequence: number;
  pending: PendingSend[];
  buffered: Message[];
};
export const emptyConversation = (): ConversationState => ({
  messages: [],
  lastAppliedSequence: 0,
  pending: [],
  buffered: [],
});

export function createPending(
  state: ConversationState,
  conversationId: string,
  requestId: string,
  body: string,
): ConversationState {
  if (
    state.pending.some((item) => item.requestId === requestId) ||
    state.messages.some((item) => item.requestId === requestId)
  )
    return state;
  return {
    ...state,
    pending: [
      ...state.pending,
      { conversationId, requestId, body, status: "sending" },
    ],
  };
}
export function applyQueued(
  state: ConversationState,
  requestId: string,
): ConversationState {
  if (
    !state.pending.some(
      (item) => item.requestId === requestId && item.status === "sending",
    )
  )
    return state;
  return {
    ...state,
    pending: state.pending.map((item) =>
      item.requestId === requestId && item.status === "sending"
        ? { ...item, status: "queued" }
        : item,
    ),
  };
}
export function applyRejected(
  state: ConversationState,
  requestId: string,
  reason: string,
): ConversationState {
  if (!state.pending.some((item) => item.requestId === requestId)) return state;
  return {
    ...state,
    pending: state.pending.map((item) =>
      item.requestId === requestId
        ? { ...item, status: "rejected", reason }
        : item,
    ),
  };
}
export function applyRetryable(
  state: ConversationState,
  requestId: string,
  reason: string,
): ConversationState {
  if (!state.pending.some((item) => item.requestId === requestId)) return state;
  return {
    ...state,
    pending: state.pending.map((item) =>
      item.requestId === requestId && item.status !== "rejected"
        ? { ...item, status: "retryable", reason }
        : item,
    ),
  };
}
export function retryPending(
  state: ConversationState,
  requestId: string,
): ConversationState {
  return {
    ...state,
    pending: state.pending.map((item) =>
      item.requestId === requestId && item.status === "retryable"
        ? { ...item, status: "sending", reason: undefined }
        : item,
    ),
  };
}
export function applyMessage(
  state: ConversationState,
  message: Message,
): ConversationState {
  if (
    message.sequence <= state.lastAppliedSequence ||
    state.buffered.some((item) => item.id === message.id)
  )
    return state;
  const buffered = [...state.buffered, message].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const messages = [...state.messages];
  let lastAppliedSequence = state.lastAppliedSequence;
  while (buffered[0]?.sequence === lastAppliedSequence + 1) {
    const next = buffered.shift();
    if (next && !messages.some((item) => item.id === next.id)) {
      messages.push(next);
      lastAppliedSequence = next.sequence;
    }
  }
  return {
    ...state,
    messages,
    buffered,
    lastAppliedSequence,
    pending: state.pending.filter(
      (item) => !messages.some((saved) => saved.requestId === item.requestId),
    ),
  };
}
