import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import type { Store } from "./db/index.js";
export const sessionCookie = "messenger_session";
export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
export function createHttp(options: { origin: string; production: boolean }) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: 16384,
  });
  app.register(cookie);
  app.addHook("onRequest", async (request) => {
    const origin = request.headers.origin;
    if (origin && origin !== options.origin)
      throw httpError(403, "Origin is not allowed");
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw httpError(403, "Cross-site requests are not allowed");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({
          error: "Invalid request",
          details: error.issues.map((issue) => issue.message),
        });
    const status =
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (status >= 500) request.log.error(error);
    return reply
      .code(status)
      .send({
        error:
          status >= 500
            ? "Service temporarily unavailable"
            : error instanceof Error
              ? error.message
              : "Request failed",
      });
  });
  return app;
}
export async function requireSession(store: Store, token: string | undefined) {
  const session = token ? await store.session(token) : null;
  if (!session) throw httpError(401, "Please sign in");
  return session;
}
