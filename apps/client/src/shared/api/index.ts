import {
  conversationSchema,
  historySchema,
  resultSchema,
  sessionSchema,
  userSchema,
  type Conversation,
  type Session,
  type User,
} from "@messenger/contracts";
import { z } from "zod";

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
      )
        detail = body.error;
    } catch {
      /* HTTP errors can have an empty body. */
    }
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return schema.parse(await response.json());
}
const json = (value: unknown) => JSON.stringify(value);
export const api = {
  session: () => request("/auth/session", sessionSchema),
  login: (username: string, password: string, deviceId: string) =>
    request("/auth/login", sessionSchema, {
      method: "POST",
      body: json({ username, password, deviceId }),
    }),
  register: (
    username: string,
    name: string,
    password: string,
    deviceId: string,
  ) =>
    request("/auth/register", sessionSchema, {
      method: "POST",
      body: json({ username, name, password, deviceId }),
    }),
  logout: async () => {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) throw new Error("Could not sign out");
  },
  users: async (search: string): Promise<User[]> =>
    (
      await request(
        `/users?search=${encodeURIComponent(search)}`,
        z.object({ users: z.array(userSchema) }),
      )
    ).users,
  conversations: async (): Promise<Conversation[]> =>
    (
      await request(
        "/conversations",
        z.object({ conversations: z.array(conversationSchema) }),
      )
    ).conversations,
  createConversation: (
    kind: "direct" | "group",
    title: string,
    memberIds: string[],
  ) =>
    request("/conversations", conversationSchema, {
      method: "POST",
      body: json({ kind, title, memberIds }),
    }),
  history: (id: string, afterSeq: number) =>
    request(
      `/conversations/${id}/messages?afterSeq=${afterSeq}&limit=100`,
      historySchema,
    ),
  status: (id: string, requestId: string) =>
    request(`/conversations/${id}/send-status/${requestId}`, resultSchema),
  removeMember: (id: string, userId: string) =>
    fetch(`/api/conversations/${id}/members/${userId}`, {
      method: "DELETE",
      credentials: "include",
    }).then((response) => {
      if (!response.ok) throw new Error("Could not remove member");
    }),
};
