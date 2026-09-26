import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import amqp from "amqplib";
import { CommandBroker } from "./command.js";

describe("RabbitMQ send commands", () => {
  it("confirms a persistent command and retries a failed handler before acking", async () => {
    const url = process.env.RABBIT_URL ?? "amqp://guest:guest@localhost:5673";
    const prefix = `messenger.test.${ulid()}.`;
    const broker = await CommandBroker.connect(url, 1, prefix);
    const requestId = ulid();
    const command = {
      conversationId: ulid(),
      requestId,
      body: "hello",
      senderId: ulid(),
      deviceId: ulid(),
    };
    let attempts = 0;
    let accepted!: () => void;
    const processed = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    try {
      await broker.consume(async (received) => {
        if (received.requestId !== requestId) return;
        attempts++;
        if (attempts === 1) throw new Error("transient database outage");
        expect(received).toEqual(command);
        accepted();
      });
      await broker.publish(command);
      await processed;
      expect(attempts).toBe(2);
    } finally {
      await broker.close();
      const connection = await amqp.connect(url);
      try {
        const channel = await connection.createChannel();
        await channel.deleteQueue(`${prefix}0`);
      } finally {
        await connection.close();
      }
    }
  });
});
