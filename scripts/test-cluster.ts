import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

type Json = Record<string, unknown>;
type Client = {
  socket: WebSocket;
  instanceId: string;
  frames: Json[];
  send(frame: Json): void;
  wait(predicate: (frame: Json) => boolean, label: string): Promise<Json>;
};

const base = (process.env.CLUSTER_URL ?? "http://localhost:8080").replace(
  /\/$/,
  "",
);
const origin = new URL(base).origin;
const wsUrl = base.replace(/^http/, "ws") + "/ws";
const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
const openSockets: WebSocket[] = [];
const execFileAsync = promisify(execFile);

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value as Json;
}
function field(value: unknown, key: string): string {
  const result = object(value)[key];
  if (typeof result !== "string" || !result) throw new Error(`Missing ${key}`);
  return result;
}
function eventRequestId(frame: Json): string | undefined {
  if (frame.type !== "event") return undefined;
  const publication = frame.publication;
  if (!publication || typeof publication !== "object") return undefined;
  const event = (publication as Json).event;
  if (!event || typeof event !== "object") return undefined;
  const data = event as Json;
  if (data.type !== "message") return undefined;
  const message = data.message;
  return message && typeof message === "object"
    ? ((message as Json).requestId as string | undefined)
    : undefined;
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function http(
  path: string,
  method = "GET",
  cookie?: string,
  body?: Json,
): Promise<{ response: Response; data: Json }> {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const content = await response.text();
  let data: Json;
  try {
    data = object(JSON.parse(content));
  } catch {
    throw new Error(
      `${method} ${path} returned non-JSON ${response.status}: ${content.slice(0, 200)}`,
    );
  }
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed ${response.status}: ${content.slice(0, 300)}`,
    );
  return { response, data };
}

type DockerContainer = {
  Id: string;
  Config: { Hostname: string; Labels: Record<string, string> };
  State: { Running: boolean };
};

async function containerFor(
  service: "api-gateway" | "ws-gateway",
  instanceId: string,
): Promise<DockerContainer> {
  const { stdout: listed } = await execFileAsync(
    "docker",
    [
      "ps",
      "--filter",
      "label=com.docker.compose.project=messenger",
      "--filter",
      `label=com.docker.compose.service=${service}`,
      "--format",
      "{{.ID}}",
    ],
    { timeout: 10_000 },
  );
  const ids = listed.trim().split(/\s+/).filter(Boolean);
  if (!ids.length)
    throw new Error(
      `No running Docker Compose ${service} containers in project messenger`,
    );
  const { stdout } = await execFileAsync("docker", ["inspect", ...ids], {
    timeout: 10_000,
  });
  const containers = JSON.parse(stdout) as DockerContainer[];
  const hostname = instanceId.split(":")[0];
  const match = containers.find(
    (container) =>
      container.State.Running &&
      container.Config.Labels["com.docker.compose.project"] === "messenger" &&
      container.Config.Labels["com.docker.compose.service"] === service &&
      hostname === container.Config.Hostname,
  );
  if (!match)
    throw new Error(
      `Could not verify ${service} instance ${instanceId} against Compose labels and hostname`,
    );
  return match;
}

async function retry<T>(work: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastError)}`);
}

async function failureDrill(input: {
  apiInstanceId: string;
  recipient: Client;
  sender: Client;
  bobCookie: string;
  aliceCookie: string;
  conversationId: string;
}): Promise<void> {
  const apiContainer = await containerFor("api-gateway", input.apiInstanceId);
  const wsContainer = await containerFor(
    "ws-gateway",
    input.recipient.instanceId,
  );
  if (input.sender.instanceId === input.recipient.instanceId)
    throw new Error("Sender and stopped recipient share a WS instance");
  const stopped: string[] = [];
  try {
    for (const container of [apiContainer, wsContainer]) {
      stopped.push(container.Id);
      await execFileAsync("docker", ["stop", "--time", "5", container.Id], {
        timeout: 15_000,
      });
    }
    await waitFor(
      () => input.recipient.socket.readyState === WebSocket.CLOSED,
      "recipient socket to close after WS stop",
    );
    if (input.sender.socket.readyState !== WebSocket.OPEN)
      throw new Error("Sender socket did not survive recipient WS stop");
    input.sender.send({ type: "ping" });
    await input.sender.wait(
      (frame) => frame.type === "pong",
      "sender ping after WS stop",
    );

    const survivingApi = new Set<string>();
    for (let attempt = 0; attempt < 36 && survivingApi.size < 2; attempt++) {
      const health = await retry(
        () => http("/api/health"),
        "surviving API health",
      );
      const id = field(health.data, "instanceId");
      if (id === input.apiInstanceId)
        throw new Error("Stopped API instance still answered health check");
      survivingApi.add(id);
    }
    if (survivingApi.size < 2)
      throw new Error(
        `Only ${survivingApi.size} API instances answered after one stopped`,
      );
    await retry(
      () => http("/api/auth/session", "GET", input.aliceCookie),
      "surviving API session",
    );
    const recoveredBob = await retry(
      () => connect(input.bobCookie),
      "recipient WS reconnect",
    );
    if (recoveredBob.instanceId === input.recipient.instanceId)
      throw new Error("Recipient reconnected to stopped WS instance");
    await subscribe(recoveredBob, `group:${input.conversationId}`);

    const secondId = `cluster_after_stop_${nonce}`;
    input.sender.send({
      type: "send",
      conversationId: input.conversationId,
      requestId: secondId,
      body: "After one replica stopped",
    });
    await input.sender.wait(
      (frame) => frame.type === "queued" && frame.requestId === secondId,
      "post-failure publisher confirmation",
    );
    await recoveredBob.wait(
      (frame) => eventRequestId(frame) === secondId,
      "post-failure live event",
    );
    const status = await retry(
      () =>
        http(
          `/api/conversations/${input.conversationId}/send-status/${secondId}`,
          "GET",
          input.aliceCookie,
        ),
      "surviving API send status",
    );
    if (status.data.status !== "saved")
      throw new Error("Post-failure command was not saved");
    const history = await retry(
      () =>
        http(
          `/api/conversations/${input.conversationId}/messages?afterSeq=1`,
          "GET",
          input.bobCookie,
        ),
      "surviving API SQL recovery",
    );
    const messages = history.data.messages;
    if (
      !Array.isArray(messages) ||
      messages.length !== 1 ||
      object(messages[0]).requestId !== secondId ||
      object(messages[0]).sequence !== 2
    )
      throw new Error(
        `Expected sequence 2 after failure, got ${JSON.stringify(messages)}`,
      );
    console.log(
      `Failure drill passed: stopped API ${input.apiInstanceId} and WS ${input.recipient.instanceId}; two API replicas and live recovery remained available.`,
    );
  } finally {
    const restarted = await Promise.allSettled(
      stopped
        .reverse()
        .map((id) =>
          execFileAsync("docker", ["start", id], { timeout: 30_000 }),
        ),
    );
    const failures = restarted.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new Error(
        `Failed to restart ${failures.length} stopped container(s): ${failures.map((result) => String(result.status === "rejected" ? result.reason : "")).join(", ")}`,
      );
  }
}

async function register(
  prefix: string,
): Promise<{ id: string; cookie: string }> {
  const { response, data } = await http(
    "/api/auth/register",
    "POST",
    undefined,
    {
      username: `${prefix}${nonce}`,
      name: prefix === "alice" ? "Alice Cluster" : "Bob Cluster",
      password: "cluster-password-123",
      deviceId: `${prefix}-device-${nonce}`,
    },
  );
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Registration did not set a session cookie");
  return { id: field(data.user, "id"), cookie };
}

async function connect(cookie: string): Promise<Client> {
  const socket = new WebSocket(wsUrl, { headers: { cookie, origin } });
  openSockets.push(socket);
  socket.on("error", () => {
    /* The readiness check reports the failed connection. */
  });
  const frames: Json[] = [];
  socket.on("message", (bytes) => {
    try {
      frames.push(object(JSON.parse(bytes.toString())));
    } catch (error) {
      console.error("Invalid WebSocket frame:", error);
    }
  });
  await waitFor(
    () =>
      frames.some((frame) => frame.type === "ready") ||
      socket.readyState === WebSocket.CLOSED,
    "WebSocket ready",
  );
  const ready = frames.find((frame) => frame.type === "ready");
  if (!ready) throw new Error("WebSocket closed before ready");
  const client: Client = {
    socket,
    instanceId: field(ready, "instanceId"),
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    wait: async (predicate, label) => {
      await waitFor(
        () => frames.some(predicate) || socket.readyState === WebSocket.CLOSED,
        label,
      );
      const found = frames.find(predicate);
      if (!found) throw new Error(`WebSocket closed before ${label}`);
      return found;
    },
  };
  return client;
}

async function subscribe(client: Client, room: string): Promise<void> {
  client.send({ type: "subscribe", room });
  await client.wait(
    (frame) => frame.type === "subscribed" && frame.room === room,
    `subscription to ${room}`,
  );
}

async function main(): Promise<void> {
  const apiInstances = new Set<string>();
  for (let attempt = 0; attempt < 36 && apiInstances.size < 3; attempt++) {
    const { data } = await http("/api/health");
    if (data.service !== "api-gateway")
      throw new Error(`Unexpected API health service: ${String(data.service)}`);
    apiInstances.add(field(data, "instanceId"));
  }
  if (apiInstances.size < 3)
    throw new Error(
      `Expected 3 API instances, found ${apiInstances.size}: ${[...apiInstances].join(", ")}`,
    );

  const [alice, bob] = await Promise.all([register("alice"), register("bob")]);
  const created = await http("/api/conversations", "POST", alice.cookie, {
    kind: "group",
    title: "Cluster check",
    memberIds: [bob.id],
  });
  const conversationId = field(created.data, "id");
  const groupRoom = `group:${conversationId}`;

  const aliceSockets: Client[] = [];
  const bobSockets: Client[] = [];
  for (let attempt = 0; attempt < 9; attempt++)
    aliceSockets.push(await connect(alice.cookie));
  for (let attempt = 0; attempt < 9; attempt++)
    bobSockets.push(await connect(bob.cookie));
  const wsInstances = new Set(
    [...aliceSockets, ...bobSockets].map((client) => client.instanceId),
  );
  if (wsInstances.size < 3)
    throw new Error(
      `Expected 3 WS instances, found ${wsInstances.size}: ${[...wsInstances].join(", ")}`,
    );
  const sender = aliceSockets[0];
  if (!sender) throw new Error("Missing Alice socket");
  const secondSender = aliceSockets.find(
    (client) => client.instanceId !== sender.instanceId,
  );
  const recipient = bobSockets.find(
    (client) => client.instanceId !== sender.instanceId,
  );
  if (!secondSender || !recipient)
    throw new Error("Could not select sockets on different WS instances");
  await Promise.all([
    subscribe(sender, groupRoom),
    subscribe(secondSender, groupRoom),
    subscribe(recipient, groupRoom),
  ]);

  const requestId = `cluster_${nonce}`;
  sender.send({
    type: "send",
    conversationId,
    requestId,
    body: "Hello across the cluster",
  });
  await sender.wait(
    (frame) => frame.type === "queued" && frame.requestId === requestId,
    "publisher confirmation",
  );
  await Promise.all([
    sender.wait(
      (frame) => eventRequestId(frame) === requestId,
      "saved event on sender",
    ),
    secondSender.wait(
      (frame) => eventRequestId(frame) === requestId,
      "saved event on sender's second socket",
    ),
    recipient.wait(
      (frame) => eventRequestId(frame) === requestId,
      "saved event on recipient's other instance",
    ),
  ]);
  const status = await http(
    `/api/conversations/${conversationId}/send-status/${requestId}`,
    "GET",
    alice.cookie,
  );
  if (status.data.status !== "saved")
    throw new Error(`Expected saved status, got ${String(status.data.status)}`);

  sender.send({
    type: "send",
    conversationId,
    requestId,
    body: "Hello across the cluster",
  });
  await waitFor(
    () =>
      sender.frames.filter(
        (frame) => frame.type === "queued" && frame.requestId === requestId,
      ).length >= 2,
    "duplicate publisher confirmation",
  );
  const history = await http(
    `/api/conversations/${conversationId}/messages?afterSeq=0`,
    "GET",
    bob.cookie,
  );
  const messages = history.data.messages;
  if (
    !Array.isArray(messages) ||
    messages.length !== 1 ||
    object(messages[0]).requestId !== requestId ||
    object(messages[0]).sequence !== 1
  )
    throw new Error(
      `Expected one saved message at sequence 1, got ${JSON.stringify(messages)}`,
    );

  if (process.env.CLUSTER_FAILURE_DRILL === "1")
    await failureDrill({
      apiInstanceId: [...apiInstances][0]!,
      recipient,
      sender,
      bobCookie: bob.cookie,
      aliceCookie: alice.cookie,
      conversationId,
    });

  console.log(
    `Cluster check passed: ${apiInstances.size} API instances, ${wsInstances.size} WS instances; sender ${sender.instanceId}, recipient ${recipient.instanceId}.`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const socket of openSockets) socket.terminate();
}
