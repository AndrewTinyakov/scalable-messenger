import { z } from "zod";
export const idSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const sequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const userSchema = z.object({
  id: idSchema,
  username: z.string(),
  name: z.string(),
});
export type User = z.infer<typeof userSchema>;
export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  sequence: sequenceSchema,
  senderId: idSchema,
  requestId: idSchema,
  body: z.string(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof messageSchema>;
export const conversationSchema = z.object({
  id: idSchema,
  kind: z.enum(["direct", "group"]),
  title: z.string(),
  members: z.array(userSchema),
  lastSequence: sequenceSchema,
  lastMessage: messageSchema.nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const sendSchema = z.object({
  conversationId: idSchema,
  requestId: idSchema,
  body: z.string().trim().min(1).max(4000),
});
export type SendRequest = z.infer<typeof sendSchema>;
export const commandSchema = sendSchema.extend({
  senderId: idSchema,
  deviceId: idSchema,
});
export type SendCommand = z.infer<typeof commandSchema>;
export const cursorSchema = z.object({
  epoch: z.string(),
  streamId: z.string().regex(/^\d+-\d+$/),
});
export type RoomCursor = z.infer<typeof cursorSchema>;
export const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), message: messageSchema }),
  z.object({ status: z.literal("rejected"), reason: z.string() }),
  z.object({ status: z.literal("unknown") }),
]);
export type SendResult = z.infer<typeof resultSchema>;
export const roomEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    eventId: idSchema,
    message: messageSchema,
  }),
  z.object({
    type: z.literal("rejected"),
    eventId: idSchema,
    conversationId: idSchema,
    requestId: idSchema,
    reason: z.string(),
  }),
  z.object({ type: z.literal("conversations_changed"), eventId: idSchema }),
]);
export type RoomEvent = z.infer<typeof roomEventSchema>;
export const publicationSchema = z.object({
  room: z.string(),
  cursor: cursorSchema,
  event: roomEventSchema,
});
export type Publication = z.infer<typeof publicationSchema>;
export const clientFrameSchema = z.discriminatedUnion("type", [
  sendSchema.extend({ type: z.literal("send") }),
  z.object({
    type: z.literal("subscribe"),
    room: z.string().max(120),
    cursor: cursorSchema.optional(),
  }),
  z.object({
    type: z.literal("applied"),
    conversationId: idSchema,
    sequence: sequenceSchema,
    room: z.string().optional(),
    cursor: cursorSchema.optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    instanceId: z.string(),
    user: userSchema,
    deviceId: idSchema,
    rooms: z.array(z.string()),
  }),
  z.object({
    type: z.literal("queued"),
    conversationId: idSchema,
    requestId: idSchema,
  }),
  z.object({ type: z.literal("event"), publication: publicationSchema }),
  z.object({ type: z.literal("recovery_failed"), room: z.string() }),
  z.object({ type: z.literal("subscribed"), room: z.string() }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    conversationId: z.string().optional(),
    retryable: z.boolean(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export const credentialsSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(8).max(128),
  deviceId: idSchema,
});
export const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(60),
});
export const createConversationSchema = z.object({
  kind: z.enum(["direct", "group"]),
  title: z.string().trim().max(80).default(""),
  memberIds: z.array(idSchema).min(1).max(49),
});
export const sessionSchema = z.object({ user: userSchema, deviceId: idSchema });
export type Session = z.infer<typeof sessionSchema>;
export const historySchema = z.object({
  messages: z.array(messageSchema),
  nextSequence: sequenceSchema,
  hasMore: z.boolean(),
});
export const roomsFor = (
  conversation: Pick<Conversation, "kind" | "id" | "members">,
): string[] =>
  conversation.kind === "group"
    ? [`group:${conversation.id}`]
    : conversation.members.map((member) => `user:${member.id}`);
