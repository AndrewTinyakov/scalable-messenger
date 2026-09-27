import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

const base = process.env.MESSENGER_BASE_URL ?? 'http://localhost:8080';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const redisNodes = ['redis-1', 'redis-2', 'redis-3', 'redis-4', 'redis-5', 'redis-6'];
const composeOptions = process.env.MESSENGER_COMPOSE_PROJECT
  ? ['-p', process.env.MESSENGER_COMPOSE_PROJECT, '-f', 'compose.yaml',
    ...(process.env.MESSENGER_COMPOSE_OVERRIDE ? ['-f', process.env.MESSENGER_COMPOSE_OVERRIDE] : [])]
  : [];

function compose(...args) {
  execFileSync('docker', ['compose', ...composeOptions, ...args], { stdio: 'pipe' });
}

async function waitForRedisCluster() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const info = execFileSync('docker', [
        'compose', ...composeOptions, 'exec', '-T', 'redis-1', 'redis-cli', 'cluster', 'info',
      ], { stdio: 'pipe' }).toString();
      const nodes = execFileSync('docker', [
        'compose', ...composeOptions, 'exec', '-T', 'redis-1', 'redis-cli', 'cluster', 'nodes',
      ], { stdio: 'pipe' }).toString().trim().split('\n');
      if (info.includes('cluster_state:ok') && nodes.length === 6 && nodes.every((node) => node.includes(' connected'))) return;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Redis Cluster did not recover');
}

function ulid() {
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let result = '';
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function connect(token) {
  const ticket = await api('/auth/ws-ticket', { token, method: 'POST' });
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, ['messenger', `messenger-ticket.${ticket.token}`]);
  const frames = [];
  const waiters = new Set();
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    frames.push(frame);
    for (const waiter of waiters) waiter();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket open failed')); }, { once: true });
  });
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify({ version: 1, ...frame })),
    async waitFor(predicate, timeoutMs = 20000, after = 0) {
      const find = () => frames.slice(after).find((frame) => predicate(frame.event ?? frame));
      if (find()) return find();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`Timed out waiting for socket frame. Saw ${JSON.stringify(frames)}`)); }, timeoutMs);
        const check = () => {
          const frame = find();
          if (frame) { clearTimeout(timeout); waiters.delete(check); resolve(frame); }
        };
        waiters.add(check);
      });
    },
  };
}

function sendQueue(senderId, recipientId) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from([senderId, recipientId].sort().join(':'))) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return `messenger.send.${hash % 4}`;
}

function rabbitQueues() {
  const output = execFileSync('docker', ['compose', ...composeOptions, 'exec', '-T',
    'rabbitmq-1', 'rabbitmqctl', 'list_queues', 'name', 'leader', 'members', '--formatter', 'json']);
  return JSON.parse(output.toString());
}

async function establishDirect(sender, recipient, senderSocket, recipientSocket) {
  const requestId = ulid();
  senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId, body: 'Open direct chat' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  return { id: (received.event ?? received).chatId };
}

test('a confirmed send is saved once and reaches another socket', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const alice = await api('/auth/register', { method: 'POST', body: { username: `alice_${suffix}`, password: 'long-demo-password' } });
  const bob = await api('/auth/register', { method: 'POST', body: { username: `bob_${suffix}`, password: 'long-demo-password' } });
  assert.deepEqual(await api('/chats', { token: alice.token }), { chats: [] });
  assert.deepEqual(await api('/chats', { token: bob.token }), { chats: [] });
  const aliceSocket = await connect(alice.token);
  const aliceSecondSocket = await connect(alice.token);
  const bobSocket = await connect(bob.token);
  t.after(() => { aliceSocket.socket.close(); aliceSecondSocket.socket.close(); bobSocket.socket.close(); });

  const requestId = ulid();
  aliceSocket.send({ type: 'send', recipientId: bob.user.id, requestId, body: 'A message across two nodes' });
  await aliceSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const received = await bobSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const senderDeviceReceived = await aliceSecondSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const event = received.event ?? received;
  const chat = { id: event.chatId };
  await aliceSecondSocket.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === chat.id);
  await bobSocket.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === chat.id);
  assert.equal((await api('/chats', { token: alice.token })).chats.length, 1);
  assert.equal((await api('/chats', { token: bob.token })).chats.length, 1);
  assert.equal((senderDeviceReceived.event ?? senderDeviceReceived).messageId, event.messageId);
  assert.equal(event.body, 'A message across two nodes');
  assert.equal(event.sequence, '1');
  assert.equal(event.senderId, alice.user.id);

  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { token: bob.token });
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, event.messageId);
  const status = await api(`/sends/${requestId}`, { token: alice.token });
  assert.equal(status.status, 'saved');
  assert.equal(status.messageId, event.messageId);

  const group = await api('/chats/groups', {
    token: alice.token,
    method: 'POST',
    body: { name: 'A second chat', memberIds: [bob.user.id] },
  });
  const { chats: listed } = await api('/chats', { token: alice.token });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, group.id);
  assert.equal(listed[0].lastSequence, '0');
  assert.equal(listed[0].memberCount, 2);
  assert.deepEqual(listed[0].members, []);
  const openedGroup = await api(`/chats/${group.id}`, { token: alice.token });
  assert.deepEqual(openedGroup.members.map((member) => member.id).sort(), [alice.user.id, bob.user.id].sort());
  assert.equal(listed[1].id, chat.id);
  assert.equal(listed[1].lastSequence, '1');
  assert.deepEqual(listed[1].members.map((member) => member.id).sort(), [alice.user.id, bob.user.id].sort());

  aliceSocket.send({ type: 'send', recipientId: bob.user.id, requestId, body: 'A message across two nodes' });
  await aliceSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const replayedHistory = await api(`/chats/${chat.id}/messages?afterSeq=0`, { token: bob.token });
  assert.equal(replayedHistory.messages.length, 1);
});

test('two processors save concurrent chat commands and one continues after its peer stops', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 120000,
}, async (t) => {
  const processors = execFileSync('docker', [
    'compose', ...composeOptions, 'ps', '--status', 'running', '-q', 'messenger-command-processor',
  ]).toString().trim().split('\n').filter(Boolean);
  assert.equal(processors.length, 2, 'expected two running command processors');

  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `parallel_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `parallel_recipient_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  const requestIds = Array.from({ length: 16 }, ulid);
  for (const [index, requestId] of requestIds.entries()) {
    senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: `Concurrent ${index}` });
  }
  await Promise.all(requestIds.map((requestId) => recipientSocket.waitFor(
    (frame) => frame.type === 'message_saved' && frame.requestId === requestId, 45000,
  )));

  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { token: recipient.token });
  assert.equal(history.messages.length, 17);
  assert.deepEqual(history.messages.map((message) => message.sequence),
    Array.from({ length: 17 }, (_, index) => String(index + 1)));
  assert.deepEqual(new Set(history.messages.slice(1).map((message) => message.body)),
    new Set(requestIds.map((_, index) => `Concurrent ${index}`)));
  recipientSocket.send({ type: 'applied', chatId: chat.id, sequence: '17' });
  senderSocket.send({ type: 'applied', chatId: chat.id, sequence: '17' });

  execFileSync('docker', ['stop', processors[0]], { stdio: 'pipe' });
  t.after(() => execFileSync('docker', ['start', processors[0]], { stdio: 'pipe' }));
  const finalRequestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId: finalRequestId, body: 'Survived one processor stop' });
  await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === finalRequestId, 30000);
  const finalStatus = await api(`/sends/${finalRequestId}`, { token: sender.token });
  assert.equal(finalStatus.status, 'saved');
  assert.equal(finalStatus.sequence, '18');
});

test('group members receive saved events and removed members lose history access', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `member_${suffix}`, password: 'long-demo-password' } });
  const other = await api('/auth/register', { method: 'POST', body: { username: `other_${suffix}`, password: 'long-demo-password' } });
  const ownerSocket = await connect(owner.token);
  const memberSocket = await connect(member.token);
  const otherSocket = await connect(other.token);
  t.after(() => { ownerSocket.socket.close(); memberSocket.socket.close(); otherSocket.socket.close(); });
  const group = await api('/chats/groups', {
    token: owner.token,
    method: 'POST',
    body: { name: 'System test group', memberIds: [member.user.id, other.user.id] },
  });
  for (const client of [ownerSocket, memberSocket, otherSocket]) {
    await client.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === group.id);
  }
  assert.equal((await api('/chats', { token: member.token })).chats.length, 1);

  for (const client of [ownerSocket, memberSocket, otherSocket]) {
    client.send({ type: 'subscribe', kind: 'group', chatId: group.id, lastAppliedSequence: '0' });
    await client.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);
  }
  const requestId = ulid();
  ownerSocket.send({ type: 'send', chatId: group.id, requestId, body: 'For the whole group' });
  await ownerSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await memberSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  await otherSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);

  await api(`/chats/${group.id}/members/${member.user.id}`, { token: owner.token, method: 'DELETE' });
  const historyResponse = await fetch(`${base}/api/v1/chats/${group.id}/messages?afterSeq=0`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  assert.ok([403, 404].includes(historyResponse.status), `removed member still fetched history: ${historyResponse.status}`);
  await memberSocket.waitFor((frame) => frame.type === 'member_removed' && frame.chatId === group.id, 15000);
  const afterRemoval = memberSocket.frames.length;
  memberSocket.send({ type: 'subscribe', kind: 'group', chatId: group.id });
  await memberSocket.waitFor((frame) => frame.type === 'error' && frame.code === 'unauthorized', 15000, afterRemoval);
  const rejectedRequestId = ulid();
  memberSocket.send({ type: 'send', chatId: group.id, requestId: rejectedRequestId, body: 'After removal' });
  await memberSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === rejectedRequestId);
  await memberSocket.waitFor((frame) => frame.type === 'send_rejected' && frame.requestId === rejectedRequestId);

  const nextRequestId = ulid();
  otherSocket.send({ type: 'send', chatId: group.id, requestId: nextRequestId, body: 'Still here' });
  await ownerSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === nextRequestId);
  const history = await api(`/chats/${group.id}/messages?afterSeq=0`, { token: owner.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['For the whole group', 'Still here']);

  await api(`/chats/${group.id}/members`, {
    token: owner.token, method: 'POST', body: { memberIds: [member.user.id] },
  });
  await memberSocket.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === group.id);
  memberSocket.send({ type: 'subscribe', kind: 'group', chatId: group.id });
  await memberSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);
});

test('a confirmed command survives a stopped command processor', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `queued_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `resume_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'direct', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  compose('stop', 'messenger-command-processor');
  t.after(() => compose('up', '-d', '--no-deps', 'messenger-command-processor'));
  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Saved after processor restart' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const pending = await api(`/sends/${requestId}`, { token: sender.token });
  assert.equal(pending.status, 'unknown');

  compose('up', '-d', '--no-deps', 'messenger-command-processor');
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId, 30000);
  assert.equal((received.event ?? received).body, 'Saved after processor restart');
  const finalStatus = await api(`/sends/${requestId}`, { token: sender.token });
  assert.equal(finalStatus.status, 'saved');
});

test('a send survives its queue leader failing and a publisher reconnect', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 120000,
}, async (t) => {
  const queues = rabbitQueues();
  assert.equal(queues.length, 5);
  for (const queue of queues) assert.equal(queue.members.length, 3);
  const targetQueue = queues.find((queue) => queue.name === 'messenger.send.0');
  assert.ok(targetQueue);
  const failedNode = targetQueue.leader.replace('rabbit@', '');
  const survivingNode = ['rabbitmq-1', 'rabbitmq-2', 'rabbitmq-3'].find((node) => node !== failedNode);

  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `fail_sender_${suffix}`, password: 'long-demo-password' } });
  let recipient;
  for (let i = 0; i < 20; i++) {
    const candidate = await api('/auth/register', { method: 'POST', body: { username: `fail_target_${i}_${suffix}`, password: 'long-demo-password' } });
    if (sendQueue(sender.user.id, candidate.user.id) === targetQueue.name) {
      recipient = candidate;
      break;
    }
  }
  assert.ok(recipient, 'could not find a direct send routed to the selected queue');
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  compose('stop', 'messenger-command-processor');
  t.after(() => compose('up', '-d', '--no-deps', 'messenger-command-processor'));
  const pendingRequestId = ulid();
  senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId: pendingRequestId, body: 'Confirmed before queue leader failure' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === pendingRequestId);
  assert.equal((await api(`/sends/${pendingRequestId}`, { token: sender.token })).status, 'unknown');

  compose('stop', failedNode);
  t.after(() => {
    compose('up', '-d', '--no-deps', failedNode);
    compose('exec', '-T', survivingNode, 'rabbitmqctl', '-t', '60', 'await_online_nodes', '3');
  });
  compose('up', '-d', '--no-deps', 'messenger-command-processor');
  const recovered = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === pendingRequestId, 30000);
  const chatId = (recovered.event ?? recovered).chatId;
  compose('exec', '-T', survivingNode, 'rabbitmqctl', 'close_all_connections', '--global', 'resilience test reconnect');

  const requestId = ulid();
  let confirmed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const after = senderSocket.frames.length;
    senderSocket.send({ type: 'send', recipientId: recipient.user.id, requestId, body: 'Saved after queue leader failure' });
    const response = await senderSocket.waitFor((frame) => frame.requestId === requestId &&
      (frame.type === 'queued' || frame.type === 'error'), 15000, after);
    if ((response.event ?? response).type === 'queued') {
      confirmed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(confirmed, 'publisher did not confirm after its broker stopped');
  await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId, 30000);
  const history = await api(`/chats/${chatId}/messages?afterSeq=0`, { token: recipient.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['Confirmed before queue leader failure', 'Saved after queue leader failure']);
  assert.equal((await api(`/sends/${pendingRequestId}`, { token: sender.token })).status, 'saved');
  const status = await api(`/sends/${requestId}`, { token: sender.token });
  assert.equal(status.status, 'saved');
});

test('a queued sender can recover a rejection after group removal', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `revoke_owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `revoke_sender_${suffix}`, password: 'long-demo-password' } });
  const group = await api('/chats/groups', {
    token: owner.token, method: 'POST', body: { name: 'Revocation test', memberIds: [member.user.id] },
  });
  const socket = await connect(member.token);
  t.after(() => socket.socket.close());
  socket.send({ type: 'subscribe', kind: 'group', chatId: group.id, lastAppliedSequence: '0' });
  await socket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);

  compose('stop', 'messenger-command-processor');
  t.after(() => compose('up', '-d', '--no-deps', 'messenger-command-processor'));
  const requestId = ulid();
  socket.send({ type: 'send', chatId: group.id, requestId, body: 'Queued before removal' });
  await socket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await api(`/chats/${group.id}/members/${member.user.id}`, {
    token: owner.token, method: 'DELETE',
  });
  compose('up', '-d', '--no-deps', 'messenger-command-processor');

  let finalStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/v1/sends/${requestId}`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    assert.equal(response.status, 200);
    finalStatus = await response.json();
    if (finalStatus.status === 'rejected') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(finalStatus, 'queued request did not reach a durable result');
  assert.equal(finalStatus.status, 'rejected');
  assert.equal(finalStatus.reason, 'NOT_A_MEMBER');
  const unknownResponse = await fetch(`${base}/api/v1/sends/${ulid()}`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  assert.equal(unknownResponse.status, 200);
  assert.equal((await unknownResponse.json()).status, 'unknown');
  const history = await api(`/chats/${group.id}/messages?afterSeq=0`, { token: owner.token });
  assert.deepEqual(history.messages, []);
});

test('SQL history remains available while Redis is down', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `redis_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `redis_reader_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'direct', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  compose('stop', 'messenger-outbox-publisher');
  t.after(async () => {
    compose('up', '-d', '--no-deps', ...redisNodes, 'messenger-outbox-publisher');
    await waitForRedisCluster();
  });
  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Recover through SQL' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await api(`/sends/${requestId}`, { token: sender.token });
    if (status.status === 'saved') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  compose('stop', ...redisNodes);
  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { token: recipient.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['Open direct chat', 'Recover through SQL']);
  if (recipientSocket.socket.readyState === WebSocket.OPEN) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket stayed open after its personal Redis room failed')), 15000);
      recipientSocket.socket.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
});

test('a trimmed Redis cursor forces SQL catch-up', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `trim_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `trim_reader_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'direct', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Before stream trim' });
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const saved = received.event ?? received;
  assert.ok(saved.epoch && saved.streamId && saved.room);
  compose('exec', '-T', 'redis-1', 'redis-cli', '-c',
    'XTRIM', `messenger:{${saved.room}}:stream`, 'MAXLEN', '0');

  const resumed = await connect(recipient.token);
  t.after(() => resumed.socket.close());
  resumed.send({
    type: 'subscribe', kind: 'direct',
    chatId: chat.id,
    epoch: saved.epoch,
    streamId: saved.streamId,
    lastAppliedSequence: saved.sequence,
  });
  await resumed.waitFor((frame) => frame.type === 'recovery_failed' && frame.chatId === chat.id);
  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { token: recipient.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['Open direct chat', 'Before stream trim']);
});
