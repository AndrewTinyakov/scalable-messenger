import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { authenticate } from './setup.mjs';
import { Http, Measurements } from './transport.mjs';

const [api, ws, origin, protocol = 'current'] = process.argv.slice(2);
assert.ok(['legacy', 'current'].includes(protocol));
for (const [value, schemes] of [[api, ['http:', 'https:']], [ws, ['ws:', 'wss:']]]) {
  const url = new URL(value);
  assert.ok(schemes.includes(url.protocol) &&
    (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')));
}

const http = new Http({ api, origin, authRate: 1, ticketRate: 4 }, new Measurements());
const accounts = [1, 2].map(() => {
  const id = randomBytes(10).toString('hex');
  return { username: 'probe' + id, deviceId: 'probe' + id, password: randomBytes(18).toString('hex') };
});
const events = new EventEmitter();
const sockets = new Set();
const idleMs = 60_000;
const offlineDetectionMs = [];
let presenceFrames = 0;
let socketError;

async function connect(account, receive = () => {}) {
  const ticket = await http.request(account, '/auth/ws-ticket', 'POST');
  const socket = new WebSocket(ws, ['messenger', `messenger-ticket.${ticket.token}`], {
    headers: { Origin: origin }, maxPayload: 65536, perMessageDeflate: false,
  });
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', error => { socketError ??= error; });
  socket.on('message', data => receive(JSON.parse(data)));
  await once(socket, 'open', { signal: AbortSignal.timeout(15_000) });
  return socket;
}

function watchStatus(online) {
  return once(events, online ? 'online' : 'offline', { signal: AbortSignal.timeout(15_000) });
}

try {
  const [viewer, subject] = accounts;
  await authenticate(http, viewer, 'register');
  await authenticate(http, subject, 'register');
  const group = await http.request(viewer, '/chats/groups', 'POST', {
    name: 'Presence benchmark probe', memberIds: [subject.userId],
  });
  let subjectSocket = await connect(subject);
  const watcher = await connect(viewer, frame => {
    if (frame.type === 'error') socketError ??= new Error(frame.code);
    if (frame.type !== 'presence') return;
    presenceFrames++;
    const status = frame.statuses.find(status => status.userId === subject.userId);
    const online = protocol === 'legacy' ? { online: true, offline: false }[status?.state] : status?.online;
    if (typeof online === 'boolean') events.emit(online ? 'online' : 'offline', performance.now());
  });
  const initial = watchStatus(true);
  watcher.send(JSON.stringify({
    type: 'watch_presence', version: 1,
    ...(protocol === 'legacy' ? { chatId: group.id, userIds: [subject.userId] } : { add: [subject.userId] }),
  }));
  await initial;
  const idleStartMs = Date.now();
  const framesBeforeIdle = presenceFrames;
  console.error(`Idle started at ${idleStartMs}`);
  await delay(idleMs);
  const idleEndMs = Date.now();
  const idlePresenceFrames = presenceFrames - framesBeforeIdle;
  console.error(`Idle ended at ${idleEndMs}`);

  for (let sample = 0; sample < 3; sample++) {
    if (sample > 0) {
      const online = watchStatus(true);
      subjectSocket = await connect(subject);
      await online;
    }
    const offline = watchStatus(false);
    const closed = once(subjectSocket, 'close', { signal: AbortSignal.timeout(15_000) });
    const started = performance.now();
    subjectSocket.close(1000);
    const [[observedAt], [code]] = await Promise.all([offline, closed]);
    assert.equal(code, 1000);
    offlineDetectionMs.push(observedAt - started);
  }
  if (socketError) throw socketError;
  console.log(JSON.stringify({ protocol, idleStartMs, idleEndMs, idlePresenceFrames, offlineDetectionMs }));
} finally {
  http.controller.abort();
  for (const socket of sockets) socket.terminate();
}
