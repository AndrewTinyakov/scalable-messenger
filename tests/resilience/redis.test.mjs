import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { redisNodes } from '../support/runtime.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { compose, startWorkers, waitForRedisCluster } from '../support/compose.mjs';
import { establishDirect } from '../support/chat-fixtures.mjs';
import { randomBytes } from 'node:crypto';

test('SQL history remains available while Redis is down', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `redis_sender_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `redis_reader_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.cookie);
  const recipientSocket = await connect(recipient.cookie);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'DIRECT', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  compose('stop', 'messenger-outbox-publisher');
  t.after(async () => {
    compose('start', ...redisNodes);
    await waitForRedisCluster();
    await startWorkers('messenger-outbox-publisher');
  });
  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Recover through SQL' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await api(`/sends/${requestId}`, { cookie: sender.cookie });
    if (status.status === 'SAVED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  compose('stop', ...redisNodes);
  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { cookie: recipient.cookie });
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
  const senderSocket = await connect(sender.cookie);
  const recipientSocket = await connect(recipient.cookie);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'DIRECT', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Before stream trim' });
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  const saved = received.event ?? received;
  assert.ok(saved.epoch && saved.streamId && saved.room);
  compose('exec', '-T', 'redis-1', 'redis-cli', '-c',
    'XTRIM', `messenger:{${saved.room}}:stream`, 'MAXLEN', '0');

  const resumed = await connect(recipient.cookie);
  t.after(() => resumed.socket.close());
  resumed.send({
    type: 'subscribe', kind: 'DIRECT',
    chatId: chat.id,
    epoch: saved.epoch,
    streamId: saved.streamId,
    lastAppliedSequence: saved.sequence,
  });
  await resumed.waitFor((frame) => frame.type === 'recovery_failed' && frame.chatId === chat.id);
  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { cookie: recipient.cookie });
  assert.deepEqual(history.messages.map((message) => message.body), ['Open direct chat', 'Before stream trim']);
});
