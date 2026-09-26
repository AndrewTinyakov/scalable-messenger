import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

const base = process.env.MESSENGER_BASE_URL ?? 'http://localhost:8080';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
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
    send: (frame) => socket.send(JSON.stringify({ version: 1, ...frame })),
    async waitFor(predicate, timeoutMs = 20000) {
      const find = () => frames.find((frame) => predicate(frame.event ?? frame));
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

test('a confirmed send is saved once and reaches another socket', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const alice = await api('/auth/register', { method: 'POST', body: { username: `alice_${suffix}`, password: 'long-demo-password' } });
  const bob = await api('/auth/register', { method: 'POST', body: { username: `bob_${suffix}`, password: 'long-demo-password' } });
  const conversation = await api('/conversations/direct', {
    token: alice.token,
    method: 'POST',
    body: { userId: bob.user.id },
  });
  const aliceSocket = await connect(alice.token);
  const aliceSecondSocket = await connect(alice.token);
  const bobSocket = await connect(bob.token);
  t.after(() => { aliceSocket.socket.close(); aliceSecondSocket.socket.close(); bobSocket.socket.close(); });

  aliceSecondSocket.send({ type: 'subscribe', conversationId: conversation.id, lastAppliedSequence: '0' });
  await aliceSecondSocket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === conversation.id);
  bobSocket.send({ type: 'subscribe', conversationId: conversation.id, lastAppliedSequence: '0' });
  await bobSocket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === conversation.id);
  const requestId = ulid();
  aliceSocket.send({ type: 'send', conversationId: conversation.id, requestId, body: 'A message across two nodes' });
  await aliceSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const received = await bobSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const senderDeviceReceived = await aliceSecondSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const event = received.event ?? received;
  assert.equal((senderDeviceReceived.event ?? senderDeviceReceived).messageId, event.messageId);
  assert.equal(event.body, 'A message across two nodes');
  assert.equal(event.sequence, '1');
  assert.equal(event.senderId, alice.user.id);

  const history = await api(`/conversations/${conversation.id}/messages?afterSeq=0`, { token: bob.token });
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, event.messageId);
  const status = await api(`/conversations/${conversation.id}/send-status/${requestId}`, { token: alice.token });
  assert.equal(status.status, 'saved');
  assert.equal(status.messageId, event.messageId);

  aliceSocket.send({ type: 'send', conversationId: conversation.id, requestId, body: 'A message across two nodes' });
  await aliceSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const replayedHistory = await api(`/conversations/${conversation.id}/messages?afterSeq=0`, { token: bob.token });
  assert.equal(replayedHistory.messages.length, 1);
});

test('group members receive saved events and removed members lose history access', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `member_${suffix}`, password: 'long-demo-password' } });
  const other = await api('/auth/register', { method: 'POST', body: { username: `other_${suffix}`, password: 'long-demo-password' } });
  const group = await api('/conversations/groups', {
    token: owner.token,
    method: 'POST',
    body: { name: 'System test group', memberIds: [member.user.id, other.user.id] },
  });
  const ownerSocket = await connect(owner.token);
  const memberSocket = await connect(member.token);
  const otherSocket = await connect(other.token);
  t.after(() => { ownerSocket.socket.close(); memberSocket.socket.close(); otherSocket.socket.close(); });

  for (const client of [ownerSocket, memberSocket, otherSocket]) {
    client.send({ type: 'subscribe', conversationId: group.id, lastAppliedSequence: '0' });
    await client.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === group.id);
  }
  const requestId = ulid();
  ownerSocket.send({ type: 'send', conversationId: group.id, requestId, body: 'For the whole group' });
  await ownerSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await memberSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  await otherSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);

  await api(`/conversations/${group.id}/members/${member.user.id}`, { token: owner.token, method: 'DELETE' });
  const historyResponse = await fetch(`${base}/api/v1/conversations/${group.id}/messages?afterSeq=0`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  assert.ok([403, 404].includes(historyResponse.status), `removed member still fetched history: ${historyResponse.status}`);
  await memberSocket.waitFor((frame) => frame.type === 'recovery_failed' && frame.conversationId === group.id, 15000);

  const nextRequestId = ulid();
  otherSocket.send({ type: 'send', conversationId: group.id, requestId: nextRequestId, body: 'Still here' });
  await ownerSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === nextRequestId);
  const history = await api(`/conversations/${group.id}/messages?afterSeq=0`, { token: owner.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['For the whole group', 'Still here']);
});

test('a confirmed command survives a stopped worker', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `queued_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `resume_${suffix}`, password: 'long-demo-password' } });
  const conversation = await api('/conversations/direct', {
    token: sender.token, method: 'POST', body: { userId: recipient.user.id },
  });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  recipientSocket.send({ type: 'subscribe', conversationId: conversation.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === conversation.id);

  execFileSync('docker', ['compose', 'stop', 'command-worker'], { stdio: 'pipe' });
  t.after(() => execFileSync('docker', ['compose', 'up', '-d', '--no-deps', 'command-worker'], { stdio: 'pipe' }));
  const requestId = ulid();
  senderSocket.send({ type: 'send', conversationId: conversation.id, requestId, body: 'Saved after worker restart' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const pending = await api(`/conversations/${conversation.id}/send-status/${requestId}`, { token: sender.token });
  assert.equal(pending.status, 'unknown');

  execFileSync('docker', ['compose', 'up', '-d', '--no-deps', 'command-worker'], { stdio: 'pipe' });
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId, 30000);
  assert.equal((received.event ?? received).body, 'Saved after worker restart');
  const finalStatus = await api(`/conversations/${conversation.id}/send-status/${requestId}`, { token: sender.token });
  assert.equal(finalStatus.status, 'saved');
});

test('a queued sender can recover a rejection after group removal', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `revoke_owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `revoke_sender_${suffix}`, password: 'long-demo-password' } });
  const group = await api('/conversations/groups', {
    token: owner.token, method: 'POST', body: { name: 'Revocation test', memberIds: [member.user.id] },
  });
  const socket = await connect(member.token);
  t.after(() => socket.socket.close());
  socket.send({ type: 'subscribe', conversationId: group.id, lastAppliedSequence: '0' });
  await socket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === group.id);

  execFileSync('docker', ['compose', 'stop', 'command-worker'], { stdio: 'pipe' });
  t.after(() => execFileSync('docker', ['compose', 'up', '-d', '--no-deps', 'command-worker'], { stdio: 'pipe' }));
  const requestId = ulid();
  socket.send({ type: 'send', conversationId: group.id, requestId, body: 'Queued before removal' });
  await socket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await api(`/conversations/${group.id}/members/${member.user.id}`, {
    token: owner.token, method: 'DELETE',
  });
  execFileSync('docker', ['compose', 'up', '-d', '--no-deps', 'command-worker'], { stdio: 'pipe' });

  let finalStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/v1/conversations/${group.id}/send-status/${requestId}`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    if (response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    assert.equal(response.status, 200);
    finalStatus = await response.json();
    if (finalStatus.status === 'rejected') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(finalStatus, 'queued request did not reach a durable result');
  assert.equal(finalStatus.status, 'rejected');
  assert.equal(finalStatus.reason, 'NOT_A_MEMBER');
  const unknownResponse = await fetch(`${base}/api/v1/conversations/${group.id}/send-status/${ulid()}`, {
    headers: { authorization: `Bearer ${member.token}` },
  });
  assert.equal(unknownResponse.status, 404);
  const history = await api(`/conversations/${group.id}/messages?afterSeq=0`, { token: owner.token });
  assert.deepEqual(history.messages, []);
});

test('SQL history remains available while Redis is down', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `redis_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `redis_reader_${suffix}`, password: 'long-demo-password' } });
  const conversation = await api('/conversations/direct', {
    token: sender.token, method: 'POST', body: { userId: recipient.user.id },
  });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  recipientSocket.send({ type: 'subscribe', conversationId: conversation.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === conversation.id);

  execFileSync('docker', ['compose', 'stop', 'outbox-relay'], { stdio: 'pipe' });
  t.after(() => execFileSync('docker', ['compose', 'up', '-d', '--no-deps', 'redis', 'outbox-relay'], { stdio: 'pipe' }));
  const requestId = ulid();
  senderSocket.send({ type: 'send', conversationId: conversation.id, requestId, body: 'Recover through SQL' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await api(`/conversations/${conversation.id}/send-status/${requestId}`, { token: sender.token });
    if (status.status === 'saved') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  execFileSync('docker', ['compose', 'stop', 'redis'], { stdio: 'pipe' });
  const history = await api(`/conversations/${conversation.id}/messages?afterSeq=0`, { token: recipient.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['Recover through SQL']);
  assert.equal(recipientSocket.socket.readyState, WebSocket.OPEN);
  await recipientSocket.waitFor((frame) => frame.type === 'recovery_failed' && frame.conversationId === conversation.id, 15000);
});

test('a trimmed Redis cursor forces SQL catch-up', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `trim_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `trim_reader_${suffix}`, password: 'long-demo-password' } });
  const conversation = await api('/conversations/direct', {
    token: sender.token, method: 'POST', body: { userId: recipient.user.id },
  });
  const senderSocket = await connect(sender.token);
  const recipientSocket = await connect(recipient.token);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  recipientSocket.send({ type: 'subscribe', conversationId: conversation.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.conversationId === conversation.id);

  const requestId = ulid();
  senderSocket.send({ type: 'send', conversationId: conversation.id, requestId, body: 'Before stream trim' });
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const saved = received.event ?? received;
  assert.ok(saved.epoch && saved.streamId && saved.room);
  execFileSync('docker', ['compose', 'exec', '-T', 'redis', 'redis-cli',
    'XTRIM', `messenger:{${saved.room}}:stream`, 'MAXLEN', '0'], { stdio: 'pipe' });

  const resumed = await connect(recipient.token);
  t.after(() => resumed.socket.close());
  resumed.send({
    type: 'subscribe',
    conversationId: conversation.id,
    epoch: saved.epoch,
    streamId: saved.streamId,
    lastAppliedSequence: saved.sequence,
  });
  await resumed.waitFor((frame) => frame.type === 'recovery_failed' && frame.conversationId === conversation.id);
  const history = await api(`/conversations/${conversation.id}/messages?afterSeq=0`, { token: recipient.token });
  assert.deepEqual(history.messages.map((message) => message.body), ['Before stream trim']);
});
