import { existsSync } from "node:fs";
import { z } from "zod";
if (existsSync(".env")) process.loadEnvFile(".env");
const env = z
  .object({
    DATABASE_URL: z
      .string()
      .default("postgres://messenger:messenger@localhost:55432/messenger"),
    RABBIT_URL: z.string().default("amqp://guest:guest@localhost:5673"),
    REDIS_URL: z.string().default("redis://localhost:6380"),
    API_PORT: z.coerce.number().int().positive().default(3001),
    GATEWAY_PORT: z.coerce.number().int().positive().default(3002),
    APP_ORIGIN: z.string().url().default("http://localhost:5180"),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  })
  .parse(process.env);
export const config = {
  databaseUrl: env.DATABASE_URL,
  rabbitUrl: env.RABBIT_URL,
  redisUrl: env.REDIS_URL,
  apiPort: env.API_PORT,
  gatewayPort: env.GATEWAY_PORT,
  origin: env.APP_ORIGIN,
  production: env.NODE_ENV === "production",
};
