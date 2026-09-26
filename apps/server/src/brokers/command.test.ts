import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import amqp from "amqplib";
import { CommandBroker } from "./command.js";

describe("RabbitMQ send commands", () => {
  const url = process.env.RABBIT_URL ?? "amqp://guest:guest@localhost:5673";
  async function removeQueues(prefix: string): Promise<void> {
    const connection = await amqp.connect(url);
    try {
      const channel = await connection.createChannel();
      for (const name of [`${prefix}0`, `${prefix}quarantine`]) {
        try {
          await channel.deleteQueue(name);
        } catch {
          /* Queue may not exist in the red test. */
        }
      }
    } finally {
      await connection.close();
    }
  }

  it("confirms a persistent command and retries a failed handler before acking", async () => {
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
      await removeQueues(prefix);
    }
  });

  it("quarantines malformed payloads and continues with valid commands", async () => {
    const prefix = `messenger.test.${ulid()}.`;
    const broker = await CommandBroker.connect(url, 1, prefix);
    const malformed = Buffer.from('{"conversationId":');
    const command = {
      conversationId: ulid(),
      requestId: ulid(),
      body: "hello",
      senderId: ulid(),
      deviceId: ulid(),
    };
    const handled: string[] = [];
    let accepted!: () => void;
    const processed = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const producer = await amqp.connect(url);
    try {
      await broker.consume(async (received) => {
        handled.push(received.requestId);
        accepted();
      });
      const channel = await producer.createConfirmChannel();
      channel.sendToQueue(`${prefix}0`, malformed, {
        persistent: true,
        mandatory: true,
        messageId: ulid(),
      });
      await channel.waitForConfirms();
      await broker.publish(command);
      await processed;
      expect(handled).toEqual([command.requestId]);
      const quarantine = await channel.get(`${prefix}quarantine`, {
        noAck: false,
      });
      expect(quarantine && quarantine.content).toEqual(malformed);
      if (quarantine) channel.ack(quarantine);
    } finally {
      await producer.close();
      await broker.close();
      await removeQueues(prefix);
    }
  });
});
