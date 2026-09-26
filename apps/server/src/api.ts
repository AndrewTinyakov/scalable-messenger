import { z } from "zod";
import {
  credentialsSchema,
  registerSchema,
  createConversationSchema,
  idSchema,
  sequenceSchema,
} from "@messenger/contracts";
import type { Store } from "./db/index.js";
import {
  instanceId,
  createHttp,
  httpError,
  requireSession,
  sessionCookie,
} from "./http.js";
export function createApi(
  store: Store,
  options: {
    origin: string;
    production: boolean;
    rateLimit?: (key: string) => Promise<boolean>;
  },
) {
  const app = createHttp(options);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: options.production,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
  app.get("/health", async () => ({
    status: "ok",
    service: "api-gateway",
    instanceId,
  }));
  app.get("/api/health", async () => ({
    status: "ok",
    service: "api-gateway",
    instanceId,
  }));
  app.get("/metrics", async () => store.metrics());
  app.post("/api/auth/register", async (request, reply) => {
    if (options.rateLimit && !(await options.rateLimit(`auth:${request.ip}`)))
      throw httpError(429, "Too many attempts. Try again shortly.");
    const { token, session } = await store.register(
      registerSchema.parse(request.body),
    );
    return reply
      .setCookie(sessionCookie, token, cookieOptions)
      .code(201)
      .send(session);
  });
  app.post("/api/auth/login", async (request, reply) => {
    if (options.rateLimit && !(await options.rateLimit(`auth:${request.ip}`)))
      throw httpError(429, "Too many attempts. Try again shortly.");
    const { token, session } = await store.login(
      credentialsSchema.parse(request.body),
    );
    return reply.setCookie(sessionCookie, token, cookieOptions).send(session);
  });
  app.get("/api/auth/session", async (request) =>
    requireSession(store, request.cookies[sessionCookie]),
  );
  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) await store.logout(token);
    return reply.clearCookie(sessionCookie, { path: "/" }).code(204).send();
  });
  app.register(async (authenticated) => {
    authenticated.addHook("preHandler", async (request) => {
      await requireSession(store, request.cookies[sessionCookie]);
    });
    const identity = async (token: string | undefined) =>
      (await requireSession(store, token)).user.id;
    authenticated.get("/api/users", async (request) => {
      const query = z
        .object({ search: z.string().max(100).default("") })
        .parse(request.query);
      return {
        users: await store.users(
          query.search,
          await identity(request.cookies[sessionCookie]),
        ),
      };
    });
    authenticated.get("/api/conversations", async (request) => ({
      conversations: await store.conversations(
        await identity(request.cookies[sessionCookie]),
      ),
    }));
    authenticated.post("/api/conversations", async (request, reply) =>
      reply
        .code(201)
        .send(
          await store.createConversation(
            await identity(request.cookies[sessionCookie]),
            createConversationSchema.parse(request.body),
          ),
        ),
    );
    authenticated.get("/api/conversations/:id/messages", async (request) => {
      const { id } = z.object({ id: idSchema }).parse(request.params);
      const { afterSeq, limit } = z
        .object({
          afterSeq: z.coerce.number().pipe(sequenceSchema).default(0),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query);
      return store.history(
        await identity(request.cookies[sessionCookie]),
        id,
        afterSeq,
        limit,
      );
    });
    authenticated.get(
      "/api/conversations/:id/send-status/:requestId",
      async (request) => {
        const { id, requestId } = z
          .object({ id: idSchema, requestId: idSchema })
          .parse(request.params);
        return store.sendStatus(
          await identity(request.cookies[sessionCookie]),
          id,
          requestId,
        );
      },
    );
    authenticated.delete(
      "/api/conversations/:id/members/:userId",
      async (request, reply) => {
        const { id, userId } = z
          .object({ id: idSchema, userId: idSchema })
          .parse(request.params);
        await store.removeMember(
          await identity(request.cookies[sessionCookie]),
          id,
          userId,
        );
        return reply.code(204).send();
      },
    );
  });
  return app;
}
