import { useCallback, useEffect, useRef, useState } from "react";
import {
  serverFrameSchema,
  type ClientFrame,
  type Publication,
  type RoomCursor,
  type ServerFrame,
} from "@messenger/contracts";

type Connection = "connecting" | "live" | "reconnecting" | "offline";
type ConnectionEvents = {
  cursorForRoom: (room: string) => RoomCursor | undefined;
  onOpen: () => void;
  onReady: () => void;
  onQueued: (conversationId: string, requestId: string) => void;
  onEvent: (publication: Publication) => void;
  onRecoveryFailed: () => void;
  onError: (frame: Extract<ServerFrame, { type: "error" }>) => void;
  onDisconnect: () => void;
};

export function useConnection(events: ConnectionEvents) {
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const socket = useRef<WebSocket | null>(null);
  const joinedRooms = useRef(new Set<string>());
  const stopped = useRef(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const sendFrame = useCallback((frame: ClientFrame) => {
    if (stopped.current || socket.current?.readyState !== WebSocket.OPEN)
      return false;
    socket.current.send(JSON.stringify(frame));
    return true;
  }, []);
  const subscribe = useCallback(
    (room: string) => {
      if (joinedRooms.current.has(room)) return;
      if (
        sendFrame({
          type: "subscribe",
          room,
          cursor: eventsRef.current.cursorForRoom(room),
        })
      )
        joinedRooms.current.add(room);
    },
    [sendFrame],
  );
  const close = useCallback(() => {
    stopped.current = true;
    socket.current?.close();
  }, []);

  useEffect(() => {
    stopped.current = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    const connect = () => {
      if (stopped.current) return;
      setConnection(attempt ? "reconnecting" : "connecting");
      joinedRooms.current.clear();
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        if (stopped.current || socket.current !== ws) return;
        attempt = 0;
        setConnection("live");
        eventsRef.current.onOpen();
      };
      ws.onmessage = (event) => {
        if (stopped.current || socket.current !== ws) return;
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
          eventsRef.current.onReady();
        } else if (frame.type === "queued") {
          eventsRef.current.onQueued(frame.conversationId, frame.requestId);
        } else if (frame.type === "event") {
          eventsRef.current.onEvent(frame.publication);
        } else if (frame.type === "recovery_failed") {
          eventsRef.current.onRecoveryFailed();
        } else if (frame.type === "error") {
          eventsRef.current.onError(frame);
        }
      };
      ws.onclose = () => {
        if (stopped.current || socket.current !== ws) return;
        setConnection("offline");
        eventsRef.current.onDisconnect();
        retryTimer = window.setTimeout(
          connect,
          Math.min(1000 * 2 ** attempt++, 15000),
        );
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      clearTimeout(retryTimer);
      close();
    };
  }, [close, subscribe]);

  return { connection, sendFrame, subscribe, close };
}
