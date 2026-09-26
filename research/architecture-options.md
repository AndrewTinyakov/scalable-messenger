# One-cluster WebSocket routing and reliability

This note separates three decisions: which gateway accepts a connection, which backend processes a command, and which gateways receive a resulting event. A load balancer answers only the first. A broker, direct node route, or room owner answers the third. The application database decides durable truth.

## Connection placement

An L4 balancer sees a TCP flow. It can choose by flow hash, source address, round robin, or connection count, depending on the product. It cannot select a desk owner from the HTTP path while passing encrypted TLS through. An L7 proxy terminates HTTP/TLS, reads the WebSocket opening request, chooses an upstream, and keeps forwarding bytes after the upgrade. An established socket stays with that upstream without any extra sticky-session feature. [AWS load-balancing behavior](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html), [NGINX WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).

Two gateway replicas provide redundancy only if the surviving replica can absorb the failed one's reconnects and the application state needed for recovery survives elsewhere. If both replicas normally run near capacity, a single failure still causes an outage for displaced clients. More replicas do not remove limits in the proxy, broker, database, network, or one hot room.

| Policy for new handshakes | Benefit | Limitation |
| --- | --- | --- |
| Round robin or weighted random | Simple spread across gateways | Long-lived connections and hot rooms may leave nodes uneven |
| Least connections | Responds to current open-socket count | A socket's message rate and fanout are invisible to the count |
| Client IP or affinity cookie | Later handshakes may return to one node | NAT/mobile addresses, dead nodes, and uneven placement; room members do not co-locate |
| Hash a user ID | One user's devices can tend to one node | Group members still spread across nodes; identity must be known before routing |
| Hash a desk ID | Desk viewers tend to one node | The desk must be known at handshake; one socket cannot be local to several desk owners |

NGINX supports `least_conn`, `ip_hash`, and `hash <key> consistent` for HTTP upstreams. Consistent hashing minimizes changes in a *mapping* when nodes change. It does not move established sockets. Adding a sixth node to five evenly loaded nodes may cause about one sixth of keys to select the new node on future handshakes in an ideal uniform model; it does not force one sixth of current clients to reconnect. Actual movement and skew depend on the hash implementation, weights, and keys. [NGINX HTTP upstream](https://nginx.org/en/docs/http/ngx_http_upstream_module.html).

The example below uses rendezvous hashing. It is a compact alternative to a hash ring with the same useful property: adding a node changes only keys for which that node becomes the winner. All L7 proxy replicas must use the same live node list and stable node IDs. The path is client-supplied routing input; the target gateway must still authenticate the client and authorize the desk. The example uses the `http-proxy` package (`npm install http-proxy`).

```js
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import httpProxy from 'http-proxy';

const nodes = [
  { id: 'gw-a', target: 'http://10.0.0.11:8080' },
  { id: 'gw-b', target: 'http://10.0.0.12:8080' },
  { id: 'gw-c', target: 'http://10.0.0.13:8080' },
];

function owner(deskId) {
  let winner;
  let best = -1n;
  for (const node of nodes) {
    const hex = createHash('sha256')
      .update(deskId).update('\0').update(node.id)
      .digest('hex').slice(0, 16);
    const score = BigInt(`0x${hex}`);
    if (score > best) { winner = node; best = score; }
  }
  return winner;
}

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (_error, _req, socket) => socket?.destroy());
const server = createServer((_req, res) => { res.writeHead(404).end(); });

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://proxy').pathname;
  const deskId = /^\/ws\/desks\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
  if (!deskId) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  proxy.ws(req, socket, head, { target: owner(deskId).target });
});

server.listen(8080);
```

This is an illustration of L7 admission routing, not a full proxy deployment. Put TLS, node discovery, health checks, graceful drain, connection limits, and trusted forwarding headers into a real deployment. `node-http-proxy` documents the WebSocket `upgrade` and `proxy.ws()` pattern. [node-http-proxy](https://github.com/http-party/node-http-proxy).

## When room affinity works

A Kanban desk can make each socket belong to one desk, known before upgrade. All connected viewers of that desk then go to one gateway. A card move travels through that gateway to the application backend, which validates and stores it. The backend sends the committed change to the gateway for local fanout. If the backend produces an event independently, it still needs a route to the gateway. A direct internal call, a desk-to-node directory, or a broker subscription can provide that route. If the gateway dies, its clients reconnect to another gateway and reload the stored desk. Keep spare capacity for this failover.

The messenger in the question has a harder graph. Alice's one socket may join chat A, chat B, and `user:alice`. Bob joins chat A; Carol joins chat B. Hashing Alice by chat A cannot also put her socket on chat B's owner. Hashing users co-locates their devices but spreads group chats. Desk affinity removes cross-node fanout only under the narrower rule of one primary desk per socket and no cross-desk or personal delivery. Opening one socket per desk is possible, but increases socket and reconnect counts.

## Event routing after placement

With arbitrary placement, each gateway keeps `room -> local sockets`. On the first local member of a room, it subscribes or binds once to that room at the broker; on the last leave, it unsubscribes. A publication then reaches each *interested gateway*, which sends to its local sockets. If 100 recipients occupy three gateways, the broker delivers three node copies and the gateways write 100 socket frames. Dynamic subscription requires handling first-join races and re-subscribing after a broker reconnect. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/), [RabbitMQ exchanges](https://www.rabbitmq.com/docs/exchanges).

| Transport | Good role here | Main trap |
| --- | --- | --- |
| Redis Pub/Sub | Live, low-overhead fanout to gateway nodes with subscriptions | At-most-once; disconnected gateways miss events |
| Redis Streams | Durable command work or bounded replay data | One consumer group shares entries among gateway consumers, so it is not broadcast to all room holders |
| RabbitMQ | Backend work queues, or one queue per gateway with dynamic room bindings | Binding/queue churn and broker ACKs do not prove browser receipt |
| Kafka | Durable application event stream and downstream processing | A standard consumer group assigns a partition to one consumer; dynamic room-aware gateway delivery needs another routing design |

Redis and RabbitMQ can be combined: a durable backend queue may process commands while Redis Pub/Sub distributes live results. Kafka can be the durable application log while Redis handles gateway fanout. No broker removes the need to model offline client recovery. [Redis Pub/Sub delivery semantics](https://redis.io/docs/latest/develop/pubsub/), [Redis consumer groups](https://redis.io/docs/latest/commands/xreadgroup/), [RabbitMQ confirms](https://www.rabbitmq.com/docs/confirms), [Kafka consumer groups](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html).

## Command processing and the outbox

For a chat command that needs an immediate saved/error response, a gateway can call the application backend over HTTP or gRPC with a command ID. The backend validates membership and commits a message. Putting every request into a queue is optional; a queued command has an initial "accepted for processing" state that differs from "message saved". A durable queue makes sense when work can be asynchronous or when buffering backend outages is part of the product contract.

Centrifugo's client RPC proxy is an example of the direct call: it forwards a WebSocket RPC request to an HTTP or gRPC backend endpoint and returns the backend result. It does not automatically save that request in a queue. [Centrifugo client RPC proxy](https://centrifugal.dev/docs/server/proxy#client-rpc-proxy).

The risky step is database commit followed by a separate event publish. A crash between them leaves a saved message without a live push. For strict live-event production, save the message and an outbox row in one database transaction. A relay publishes outbox rows and marks them sent after broker confirmation. The relay may publish twice if it crashes after confirmation and before marking a row, so events need stable IDs and deduplication. The sender can receive "saved" as soon as the database commits; it need not wait for every recipient socket. [Debezium outbox router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html), [RabbitMQ confirms](https://www.rabbitmq.com/docs/confirms).

An outbox need not wait for a slow cron job. The request can attempt a publish after commit while a retry worker remains as backup. Alternatively, a Postgres `NOTIFY` committed with the outbox row can wake a worker immediately; a periodic scan remains necessary because notifications are not the durable record. Change-data capture is another relay mechanism. These designs trade operational work against relay lag. Measure it rather than assuming the outbox is inherently slow. [Postgres NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [Postgres LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [Debezium outbox router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html).

If a missed live push is acceptable because a client will sync on reconnect or refresh, start with database commit then best-effort publish. State that contract honestly. An outbox strengthens the promise that every saved event will eventually be emitted; it still cannot prove that a disconnected browser saw the event.

## Recovery and delivery claims

Give every stored chat event a stable ULID and keep its broker history position separate. On reconnect, the client supplies its last applied broker epoch and offset. A short broker history can fill a small gap; when it cannot, refresh an authoritative recent view from the API. This does not promise an exact `after ULID` long-offline catch-up query. That stronger contract requires a separate commit-consistent database cursor. See the [Messenger architecture](messenger-architecture.md). Centrifugo implements bounded history with an epoch and offset and reports when recovery failed; its history is a cache, not permanent chat storage. [Centrifugo history and recovery](https://centrifugal.dev/docs/server/history_and_recovery).

The first subscribe has a race with loading a snapshot. A safe protocol installs the live subscription and buffers new events, reads the snapshot and its high-water mark, then drains buffered events above that mark while deduplicating IDs. A server with an atomic subscribe-and-history operation can hide these steps. Either way, the client must not silently skip an interval.

There are three useful delivery claims: "saved in the database", "available for an authorized client to recover", and "acknowledged by a particular device". The last requires a client ACK and stored per-device progress if it must survive failures. Even then, a lost ACK can cause duplicate delivery; idempotency is still needed. Permanent offline clients and finite retention prevent an unconditional promise that every device will receive every event. [RabbitMQ acknowledgements](https://www.rabbitmq.com/docs/confirms), [Centrifugo recovery](https://centrifugal.dev/docs/server/history_and_recovery).

## Authorization and session life

The backend can authorize a room asynchronously. The gateway waits for the result before joining the local room or granting history access. A signed, short-lived room token can reduce backend calls, while a subscribe proxy checks current membership on each relevant request. Centrifugo supports subscription JWTs, subscribe proxies, user-limited personal channels, and backend-assigned subscriptions. A rule change in the backend need not redeploy the gateway. Already-open permissions still need expiry or an explicit unsubscribe/disconnect event when membership is revoked. [Centrifugo permissions](https://centrifugal.dev/docs/server/channel_permissions), [subscribe proxy](https://centrifugal.dev/docs/server/proxy), [server-side subscriptions](https://centrifugal.dev/docs/server/server_subs).

A JWT accepted at handshake does not automatically close the socket when its expiry passes. Forcing every client to reconnect at a common 15-minute boundary creates avoidable churn. Refresh or revalidate the session while connected, spread expiry times, and close or unsubscribe promptly on revocation. Browser clients cannot set arbitrary headers with the standard `WebSocket` constructor; cookies with Origin checks or a short-lived connection ticket are common options. Query-string tickets need log redaction. [MDN WebSocket constructor](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket), [OWASP WebSocket security](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

For a browser connection, the server normally sends a WebSocket Ping and the browser responds with Pong at the protocol level. The browser JavaScript API does not expose a general Ping method; an application heartbeat message is a separate choice. The heartbeat and proxy idle timeout must agree. [ws heartbeat example](https://github.com/websockets/ws/blob/master/README.md#how-to-detect-and-close-broken-connections), [NGINX WebSocket proxying](https://nginx.org/en/docs/http/websocket.html).
