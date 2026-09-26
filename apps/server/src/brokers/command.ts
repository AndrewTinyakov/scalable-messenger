import { createHash, randomUUID } from "node:crypto";
import amqp, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import { commandSchema, type SendCommand } from "@messenger/contracts";

const DEFAULT_QUEUE_PREFIX = "messenger.commands.";
const MAX_BACKLOG = 10_000;
const PREFETCH = 16;

export class CommandBroker {
  private readonly disconnectHandlers = new Set<() => void>();
  private constructor(
    private readonly connection: ChannelModel,
    private readonly publisher: ConfirmChannel,
    private readonly partitions: number,
    private readonly queuePrefix: string,
  ) {
    connection.on("close", () => {
      for (const handler of this.disconnectHandlers) handler();
    });
    connection.on("error", (error) =>
      console.error("RabbitMQ connection error:", error),
    );
    publisher.on("error", (error) =>
      console.error("RabbitMQ publisher error:", error),
    );
  }

  static async connect(
    url: string,
    partitions = 4,
    queuePrefix = DEFAULT_QUEUE_PREFIX,
  ): Promise<CommandBroker> {
    if (!Number.isSafeInteger(partitions) || partitions < 1)
      throw new Error("partitions must be positive");
    if (!/^[a-zA-Z0-9_.-]{1,180}\.$/.test(queuePrefix))
      throw new Error("Invalid queue prefix");
    const connection = await amqp.connect(url);
    try {
      const publisher = await connection.createConfirmChannel();
      for (let index = 0; index < partitions; index++) {
        await publisher.assertQueue(`${queuePrefix}${index}`, {
          durable: true,
          arguments: {
            "x-queue-type": "quorum",
            "x-max-length": MAX_BACKLOG,
            "x-overflow": "reject-publish",
            // RabbitMQ 4 otherwise discards a confirmed command after 20 crash redeliveries.
            "x-delivery-limit": -1,
          },
        });
      }
      await publisher.assertQueue(`${queuePrefix}quarantine`, {
        durable: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-max-length": MAX_BACKLOG,
          "x-overflow": "reject-publish",
          "x-delivery-limit": -1,
        },
      });
      return new CommandBroker(connection, publisher, partitions, queuePrefix);
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  async publish(input: SendCommand): Promise<void> {
    const command = commandSchema.parse(input);
    const hash = createHash("sha256").update(command.conversationId).digest();
    const partition = hash.readUInt32BE(0) % this.partitions;
    const queue = `${this.queuePrefix}${partition}`;
    const body = Buffer.from(JSON.stringify(command));
    await this.publishRaw(queue, body, command.requestId);
  }

  private async publishRaw(
    queue: string,
    body: Buffer,
    messageId: string,
  ): Promise<void> {
    const correlationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.publisher.off("return", onReturn);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("RabbitMQ publisher confirm timed out")),
        5_000,
      );
      const onReturn = (message: ConsumeMessage) => {
        if (message.properties.correlationId !== correlationId) return;
        finish(new Error(`Command was unroutable: ${queue}`));
      };
      this.publisher.on("return", onReturn);
      try {
        this.publisher.sendToQueue(
          queue,
          body,
          {
            persistent: true,
            mandatory: true,
            messageId,
            correlationId,
            contentType: "application/json",
          },
          (error) => {
            finish(error ?? undefined);
          },
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async consume(
    handler: (command: SendCommand) => Promise<unknown>,
  ): Promise<void> {
    const channel = await this.connection.createChannel();
    channel.on("error", (error) =>
      console.error("RabbitMQ consumer error:", error),
    );
    const attempts = new Map<string, number>();
    const requeue = async (message: ConsumeMessage, error: unknown) => {
      console.error("Command processing failed; requeueing:", error);
      const key =
        message.properties.messageId ?? message.content.toString("base64");
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(count - 1, 5));
      await new Promise((resolve) => setTimeout(resolve, backoff));
      try {
        channel.nack(message, false, true);
      } catch {
        /* Connection loss requeues unacked deliveries. */
      }
    };
    await channel.prefetch(PREFETCH);
    for (let index = 0; index < this.partitions; index++) {
      await channel.consume(
        `${this.queuePrefix}${index}`,
        (message) => {
          if (!message) return;
          void (async () => {
            let command: SendCommand;
            try {
              command = commandSchema.parse(
                JSON.parse(message.content.toString("utf8")),
              );
            } catch (error) {
              try {
                await this.publishRaw(
                  `${this.queuePrefix}quarantine`,
                  message.content,
                  message.properties.messageId ?? randomUUID(),
                );
                channel.ack(message);
                console.error("Malformed command quarantined:", error);
              } catch (quarantineError) {
                await requeue(message, quarantineError);
              }
              return;
            }
            try {
              await handler(command);
              attempts.delete(command.requestId);
              channel.ack(message);
            } catch (error) {
              await requeue(message, error);
            }
          })();
        },
        { noAck: false },
      );
    }
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }
}
