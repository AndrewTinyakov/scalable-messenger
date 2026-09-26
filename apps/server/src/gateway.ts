import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { FastifyRequest } from "fastify";
import {
  clientFrameSchema,
  type Publication,
  type RoomCursor,
  type ServerFrame,
  type Session,
} from "@messenger/contracts";
import type { Store } from "./db/index.js";
import type { CommandBroker, RedisRooms } from "./brokers/index.js";
import {
  instanceId,
  createHttp,
  requireSession,
  sessionCookie,
} from "./http.js";
type Listener = {
  socket: WebSocket;
  session: Session;
  token: string;
  rooms: Set<string>;
  buffers: Map<string, Publication[]>;
  chain: Promise<void>;
  pending: number;
  alive: boolean;
  localWindow: number;
  localCount: number;
};
type LiveRoom = {
  listeners: Set<Listener>;
  start: Promise<() => Promise<void>>;
  cursor: RoomCursor | null;
};
export function createGateway(
  store: Store,
  broker: CommandBroker,
  redis: RedisRooms,
  options: { origin: string; production: boolean },
) {
  const app = createHttp(options);
  app.register(websocket, { options: { maxPayload: 16384 } });
  const liveRooms = new Map<string, LiveRoom>();
  const clients = new Set<Listener>();
  function send(client: Listener, frame: ServerFrame) {
    if (client.socket.readyState !== 1) return;
    if (client.socket.bufferedAmount > 256 * 1024) {
      client.socket.close(1013, "Please reconnect to recover history");
      return;
    }
    client.socket.send(JSON.stringify(frame));
  }
  function enqueue(client: Listener, work: () => Promise<void>) {
    if (++client.pending > 128) {
      client.pending--;
      client.socket.close(1013, "Too many pending events");
      return;
    }
    client.chain = client.chain
      .then(async () => {
        if (client.socket.readyState === 1) await work();
      })
      .catch((error) => {
        app.log.warn(error);
        send(client, {
          type: "error",
          code: "unavailable",
          message: "Connection interrupted. Retry shortly.",
          retryable: true,
        });
      })
      .finally(() => {
        client.pending--;
      });
  }
  async function authorized(client: Listener, room: string) {
    if (!(await store.session(client.token))) {
      client.socket.close(1008, "Session expired");
      return false;
    }
    if (!(await store.authorizeRoom(client.session.user.id, room))) {
      client.socket.close(1008, "Room access changed");
      return false;
    }
    return true;
  }
  async function deliver(client: Listener, publication: Publication) {
    if (await authorized(client, publication.room))
      send(client, { type: "event", publication });
  }
  async function join(client: Listener, room: string, cursor?: RoomCursor) {
    if (!(await authorized(client, room))) return;
    client.buffers.set(room, []);
    let state = liveRooms.get(room);
    if (!state) {
      state = {
        listeners: new Set(),
        start: Promise.resolve(async () => {}),
        cursor: null,
      };
      liveRooms.set(room, state);
      const active = state;
      state.start = redis.subscribe(room, (publication) => {
        active.cursor = publication.cursor;
        for (const listener of active.listeners) {
          const buffer = listener.buffers.get(room);
          if (buffer) {
            if (buffer.length >= 1000)
              listener.socket.close(1013, "Recovery buffer full");
            else buffer.push(publication);
          } else enqueue(listener, () => deliver(listener, publication));
        }
      });
    }
    state.listeners.add(client);
    client.rooms.add(room);
    try {
      await state.start;
      const replay = await redis.replay(room, cursor);
      if (!replay.recovered) send(client, { type: "recovery_failed", room });
      for (const publication of replay.publications)
        await deliver(client, publication);
      // Keep buffering while authorization checks yield; drain until no events remain.
      const buffer = client.buffers.get(room) ?? [];
      while (buffer.length) {
        const publication = buffer.shift();
        if (publication) await deliver(client, publication);
      }
      client.buffers.delete(room);
      send(client, { type: "subscribed", room });
    } catch (error) {
      client.buffers.delete(room);
      send(client, { type: "recovery_failed", room });
      throw error;
    }
  }
  async function leave(client: Listener) {
    clients.delete(client);
    for (const room of client.rooms) {
      const state = liveRooms.get(room);
      if (!state) continue;
      state.listeners.delete(client);
      if (!state.listeners.size) {
        liveRooms.delete(room);
        try {
          const stop = await state.start;
          await stop();
        } catch (error) {
          app.log.warn(error);
        }
      }
    }
    client.rooms.clear();
    client.buffers.clear();
  }
  app.get("/health", async () => ({
    status: "ok",
    service: "ws-gateway",
    instanceId,
    sockets: clients.size,
    rooms: liveRooms.size,
  }));
  const sessions = new WeakMap<FastifyRequest, Session>();
  app.register(async (routes) => {
    routes.get(
      "/ws",
      {
        websocket: true,
        preValidation: async (request) => {
          sessions.set(
            request,
            await requireSession(store, request.cookies[sessionCookie]),
          );
        },
      },
      (socket, request) => {
        const token = request.cookies[sessionCookie]!;
        // Attach listeners synchronously so early browser frames cannot be lost.
        const client: Listener = {
          socket,
          token,
          session: sessions.get(request)!,
          rooms: new Set(),
          buffers: new Map(),
          chain: Promise.resolve(),
          pending: 0,
          alive: true,
          localWindow: Date.now(),
          localCount: 0,
        };
        clients.add(client);
        client.chain = (async () => {
          client.session = await requireSession(store, token);
          send(client, {
            type: "ready",
            instanceId,
            ...client.session,
            rooms: await store.rooms(client.session.user.id),
          });
        })().catch(() => socket.close(1008, "Please sign in"));
        socket.on("pong", () => {
          client.alive = true;
        });
        socket.on("error", (error) => app.log.warn(error));
        socket.on("close", () => void leave(client));
        socket.on("message", (data) =>
          enqueue(client, async () => {
            if (!(await store.session(token))) {
              socket.close(1008, "Session expired");
              return;
            }
            const parsed = clientFrameSchema.safeParse(
              (() => {
                try {
                  return JSON.parse(data.toString());
                } catch {
                  return null;
                }
              })(),
            );
            if (!parsed.success) {
              send(client, {
                type: "error",
                code: "invalid_frame",
                message: "Invalid message frame",
                retryable: false,
              });
              return;
            }
            const frame = parsed.data;
            if (frame.type === "ping") {
              send(client, { type: "pong" });
              return;
            }
            if (frame.type === "subscribe") {
              await join(client, frame.room, frame.cursor);
              return;
            }
            if (frame.type === "applied") {
              await store.applied(
                client.session.user.id,
                client.session.deviceId,
                frame.conversationId,
                frame.sequence,
              );
              return;
            }
            if (Date.now() - client.localWindow > 10000) {
              client.localCount = 0;
              client.localWindow = Date.now();
            }
            if (
              ++client.localCount > 30 ||
              !(await redis.rateLimit(client.session.user.id))
            ) {
              send(client, {
                type: "error",
                code: "rate_limited",
                message: "Please wait before sending again",
                retryable: true,
                requestId: frame.requestId,
                conversationId: frame.conversationId,
              });
              return;
            }
            try {
              await broker.publish({
                ...frame,
                senderId: client.session.user.id,
                deviceId: client.session.deviceId,
              });
              send(client, {
                type: "queued",
                requestId: frame.requestId,
                conversationId: frame.conversationId,
              });
            } catch (error) {
              app.log.warn(error);
              send(client, {
                type: "error",
                code: "queue_unavailable",
                message:
                  "Send could not be confirmed. Retry with the same request.",
                retryable: true,
                requestId: frame.requestId,
                conversationId: frame.conversationId,
              });
            }
          }),
        );
      },
    );
  });
  const disconnected = redis.onDisconnect(() => {
    for (const [room, state] of liveRooms)
      for (const client of state.listeners)
        send(client, { type: "recovery_failed", room });
  });
  const reconnected = redis.onReconnect(() => {
    for (const [room, state] of liveRooms)
      for (const client of state.listeners)
        send(client, { type: "recovery_failed", room });
  });
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      for (const client of clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
        if (!(await store.session(client.token)))
          client.socket.close(1008, "Session expired");
      }
      for (const [room, state] of liveRooms) {
        const previous = state.cursor;
        const tail = await redis.tail(room);
        if (
          tail?.epoch !== previous?.epoch ||
          tail?.streamId !== previous?.streamId
        ) {
          const replay = await redis.replay(room, previous ?? undefined);
          if (replay.recovered) {
            for (const publication of replay.publications) {
              for (const client of state.listeners) {
                const buffer = client.buffers.get(room);
                if (buffer) {
                  if (buffer.length >= 1000)
                    client.socket.close(1013, "Recovery buffer full");
                  else buffer.push(publication);
                } else enqueue(client, () => deliver(client, publication));
              }
            }
          } else {
            for (const client of state.listeners)
              send(client, { type: "recovery_failed", room });
          }
          // Do not overwrite a newer publication received while the check yielded.
          if (state.cursor === previous) state.cursor = tail;
        }
        for (const client of state.listeners) await authorized(client, room);
      }
    })()
      .catch((error) => app.log.warn(error))
      .finally(() => {
        checking = false;
      });
  }, 15000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    disconnected();
    reconnected();
    for (const client of clients) {
      client.socket.terminate();
      await leave(client);
    }
  });
  return app;
}
