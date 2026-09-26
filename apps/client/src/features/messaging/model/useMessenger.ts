import { useCallback, useEffect, useRef, useState } from "react";
import {
  serverFrameSchema,
  type ClientFrame,
  type Conversation,
  type RoomCursor,
  type Session,
} from "@messenger/contracts";
import { api } from "../../../shared/api";
import {
  applyMessage,
  applyQueued,
  applyRejected,
  applyRetryable,
  createPending,
  emptyConversation,
  retryPending,
  type ConversationState,
} from "../../../entities/message";

import { clearCache, loadCache, saveCache } from "./cache";
type Connection = "connecting" | "live" | "reconnecting" | "offline";

export function useMessenger(session: Session) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [initialCache] = useState(() => loadCache(session));
  const [states, setStates] = useState<Record<string, ConversationState>>(
    initialCache.states,
  );
  const cursorsRef = useRef<Record<string, RoomCursor>>(initialCache.cursors);
  const joinedRooms = useRef(new Set<string>());
  const blockedRooms = useRef(new Set<string>());
  const cursorReady = useRef(false);
  const syncs = useRef(new Map<string, Promise<boolean>>());
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const socket = useRef<WebSocket | null>(null);
  const statesRef = useRef(states);
  const activeRef = useRef(true);
  const refreshRef = useRef<() => Promise<boolean>>(async () => false);
  const syncRef = useRef<(id: string) => Promise<boolean>>(async () => false);
  const sendFrame = useCallback((frame: ClientFrame) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(frame));
    return true;
  }, []);
  const persist = useCallback(
    (next: Record<string, ConversationState> = statesRef.current) => {
      return (
        activeRef.current &&
        saveCache(session, { states: next, cursors: cursorsRef.current })
      );
    },
    [session],
  );
  const subscribe = useCallback(
    (room: string) => {
      if (joinedRooms.current.has(room)) return;
      if (
        sendFrame({ type: "subscribe", room, cursor: cursorsRef.current[room] })
      )
        joinedRooms.current.add(room);
    },
    [sendFrame],
  );
  const updateState = useCallback(
    (
      id: string,
      transform: (state: ConversationState) => ConversationState,
    ) => {
      const next = {
        ...statesRef.current,
        [id]: transform(statesRef.current[id] ?? emptyConversation()),
      };
      statesRef.current = next;
      const stored = persist(next);
      setStates(next);
      return stored;
    },
    [persist],
  );
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const next = await api.conversations();
      if (!activeRef.current) return false;
      setConversations(next);
      for (const conversation of next) {
        if (conversation.kind === "group")
          subscribe(`group:${conversation.id}`);
      }
      const results = await Promise.all(
        next.map((conversation) => syncRef.current(conversation.id)),
      );
      return results.every(Boolean);
    } catch (cause) {
      if (activeRef.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not load conversations",
        );
      return false;
    }
  }, [subscribe]);
  refreshRef.current = refresh;
  const sync = useCallback(
    (id: string): Promise<boolean> => {
      const running = syncs.current.get(id);
      if (running) return running;
      const work = (async () => {
        let after = statesRef.current[id]?.lastAppliedSequence ?? 0;
        try {
          while (activeRef.current) {
            const history = await api.history(id, after);
            if (!activeRef.current) return false;
            let stored = true;
            for (const message of history.messages) {
              stored =
                updateState(id, (state) => applyMessage(state, message)) &&
                stored;
            }
            const applied = statesRef.current[id]?.lastAppliedSequence ?? after;
            if (stored && applied > after)
              sendFrame({
                type: "applied",
                conversationId: id,
                sequence: applied,
              });
            if (!history.hasMore) return stored;
            if (history.nextSequence <= after)
              throw new Error("History did not advance");
            after = history.nextSequence;
          }
          return false;
        } catch (cause) {
          if (activeRef.current)
            setError(
              cause instanceof Error ? cause.message : "Could not load history",
            );
          return false;
        }
      })();
      syncs.current.set(id, work);
      void work.finally(() => {
        if (syncs.current.get(id) === work) syncs.current.delete(id);
      });
      return work;
    },
    [sendFrame, updateState],
  );
  syncRef.current = sync;
  const reconcile = useCallback(async () => {
    const complete = await refreshRef.current();
    if (!activeRef.current) return;
    if (
      complete &&
      Object.values(statesRef.current).every(
        (state) => state.buffered.length === 0,
      )
    ) {
      blockedRooms.current.clear();
      cursorReady.current = true;
    }
    for (const [id, state] of Object.entries(statesRef.current)) {
      for (const item of state.pending) {
        if (item.status === "rejected") continue;
        try {
          const result = await api.status(id, item.requestId);
          if (!activeRef.current) return;
          if (result.status === "saved") {
            updateState(id, (current) => applyMessage(current, result.message));
            void syncRef.current(id);
          }
          if (result.status === "unknown")
            updateState(id, (current) =>
              applyRetryable(
                current,
                item.requestId,
                "No confirmed result yet. Retry safely with the same request.",
              ),
            );
          if (result.status === "rejected")
            updateState(id, (current) =>
              applyRejected(current, item.requestId, result.reason),
            );
        } catch {
          /* Retry status on the next reconciliation. */
        }
      }
    }
  }, [updateState]);
  useEffect(() => {
    activeRef.current = true;
    let attempt = 0;
    let retryTimer: number | undefined;
    let stopped = false;
    const connect = () => {
      if (stopped || !activeRef.current) return;
      setConnection(attempt ? "reconnecting" : "connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      joinedRooms.current.clear();
      cursorReady.current = false;
      const ws = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection("live");
        void reconcile();
      };
      ws.onmessage = (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = serverFrameSchema.safeParse(raw);
        if (!parsed.success) return;
        const frame = parsed.data;
        if (frame.type === "ready") {
          for (const room of frame.rooms) subscribe(room);
          void reconcile();
        } else if (frame.type === "queued") {
          updateState(frame.conversationId, (state) =>
            applyQueued(state, frame.requestId),
          );
        } else if (frame.type === "event") {
          const event = frame.publication.event;
          if (event.type === "message") {
            const message = event.message;
            const before =
              statesRef.current[message.conversationId]?.lastAppliedSequence ??
              0;
            const messageStored = updateState(message.conversationId, (state) =>
              applyMessage(state, message),
            );
            const after =
              statesRef.current[message.conversationId]?.lastAppliedSequence ??
              0;
            if (message.sequence > after) {
              blockedRooms.current.add(frame.publication.room);
              const { [frame.publication.room]: _oldCursor, ...safeCursors } =
                cursorsRef.current;
              cursorsRef.current = safeCursors;
              persist();
              void syncRef.current(message.conversationId);
            }
            if (
              message.sequence <= after &&
              cursorReady.current &&
              !blockedRooms.current.has(frame.publication.room)
            ) {
              cursorsRef.current = {
                ...cursorsRef.current,
                [frame.publication.room]: frame.publication.cursor,
              };
              const cursorStored = persist();
              if (messageStored && cursorStored && after > before)
                sendFrame({
                  type: "applied",
                  conversationId: message.conversationId,
                  sequence: after,
                  room: frame.publication.room,
                  cursor: frame.publication.cursor,
                });
            }
            void refreshRef.current();
          } else if (event.type === "rejected")
            updateState(event.conversationId, (state) =>
              applyRejected(state, event.requestId, event.reason),
            );
          else void refreshRef.current();
        } else if (frame.type === "recovery_failed") void reconcile();
        else if (frame.type === "error") {
          if (frame.conversationId && frame.requestId)
            updateState(frame.conversationId, (state) =>
              frame.retryable
                ? applyRetryable(state, frame.requestId!, frame.message)
                : applyRejected(state, frame.requestId!, frame.message),
            );
          else setError(frame.message);
        }
      };
      ws.onclose = () => {
        if (stopped || !activeRef.current) return;
        setConnection("offline");
        cursorReady.current = false;
        for (const [id, state] of Object.entries(statesRef.current))
          for (const item of state.pending) {
            if (item.status === "sending" || item.status === "queued")
              updateState(id, (current) =>
                applyRetryable(
                  current,
                  item.requestId,
                  "Connection lost. Check status or retry.",
                ),
              );
          }
        retryTimer = window.setTimeout(
          connect,
          Math.min(1000 * 2 ** attempt++, 15000),
        );
      };
      ws.onerror = () => ws.close();
    };
    connect();
    const interval = window.setInterval(() => {
      if (!document.hidden) void reconcile();
    }, 15000);
    const onFocus = () => void reconcile();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      stopped = true;
      activeRef.current = false;
      clearTimeout(retryTimer);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      socket.current?.close();
    };
  }, [persist, reconcile, sendFrame, subscribe, updateState]);
  const send = useCallback(
    (
      conversationId: string,
      body: string,
      requestId = crypto.randomUUID().replaceAll("-", ""),
    ) => {
      const text = body.trim();
      if (!text || text.length > 4000) return false;
      updateState(conversationId, (state) =>
        createPending(state, conversationId, requestId, text),
      );
      if (!sendFrame({ type: "send", conversationId, requestId, body: text }))
        updateState(conversationId, (state) =>
          applyRetryable(
            state,
            requestId,
            "Connection lost. Retry when connected.",
          ),
        );
      return true;
    },
    [sendFrame, updateState],
  );
  const retry = useCallback(
    (conversationId: string, requestId: string) => {
      const item = statesRef.current[conversationId]?.pending.find(
        (pending) => pending.requestId === requestId,
      );
      if (!item || item.status !== "retryable") return;
      updateState(conversationId, (state) => retryPending(state, requestId));
      send(conversationId, item.body, requestId);
    },
    [send, updateState],
  );
  const create = useCallback(
    async (kind: "direct" | "group", title: string, memberIds: string[]) => {
      const conversation = await api.createConversation(kind, title, memberIds);
      await refresh();
      return conversation;
    },
    [refresh],
  );
  const logout = useCallback(async () => {
    await api.logout();
    activeRef.current = false;
    clearCache(session);
    statesRef.current = {};
    cursorsRef.current = {};
    setStates({});
    socket.current?.close();
  }, [session]);
  return {
    conversations,
    states,
    connection,
    error,
    setError,
    send,
    retry,
    sync,
    refresh,
    create,
    logout,
  };
}
