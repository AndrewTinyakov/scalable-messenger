import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { apiBase, composeOptions } from '../support/runtime.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { compose } from '../support/compose.mjs';
import { establishDirect } from '../support/chat-fixtures.mjs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

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
  const senderSocket = await connect(sender.cookie);
  const recipientSocket = await connect(recipient.cookie);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  const requestIds = Array.from({ length: 16 }, ulid);
  for (const [index, requestId] of requestIds.entries()) {
    senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: `Concurrent ${index}` });
  }
  await Promise.all(requestIds.map((requestId) => recipientSocket.waitFor(
    (frame) => frame.type === 'message_saved' && frame.requestId === requestId, 45000,
  )));

  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { cookie: recipient.cookie });
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
  const finalStatus = await api(`/sends/${finalRequestId}`, { cookie: sender.cookie });
  assert.equal(finalStatus.status, 'SAVED');
  assert.equal(finalStatus.sequence, '18');
});

test('a confirmed command survives a stopped command processor', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const sender = await api('/auth/register', { method: 'POST', body: { username: `queued_${suffix}`, password: 'long-demo-password' } });
  const recipient = await api('/auth/register', { method: 'POST', body: { username: `resume_${suffix}`, password: 'long-demo-password' } });
  const senderSocket = await connect(sender.cookie);
  const recipientSocket = await connect(recipient.cookie);
  t.after(() => { senderSocket.socket.close(); recipientSocket.socket.close(); });
  const chat = await establishDirect(sender, recipient, senderSocket, recipientSocket);
  recipientSocket.send({ type: 'subscribe', kind: 'DIRECT', chatId: chat.id, lastAppliedSequence: '0' });
  await recipientSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === chat.id);

  compose('stop', 'messenger-command-processor');
  t.after(() => compose('up', '-d', '--no-deps', 'messenger-command-processor'));
  const requestId = ulid();
  senderSocket.send({ type: 'send', chatId: chat.id, requestId, body: 'Saved after processor restart' });
  await senderSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const pending = await api(`/sends/${requestId}`, { cookie: sender.cookie });
  assert.equal(pending.status, 'UNKNOWN');

  compose('up', '-d', '--no-deps', 'messenger-command-processor');
  const received = await recipientSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId, 30000);
  assert.equal((received.event ?? received).body, 'Saved after processor restart');
  const finalStatus = await api(`/sends/${requestId}`, { cookie: sender.cookie });
  assert.equal(finalStatus.status, 'SAVED');
});

test('a queued sender can recover a rejection after group removal', {
  skip: process.env.MESSENGER_RESILIENCE !== '1',
  timeout: 90000,
}, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `revoke_owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `revoke_sender_${suffix}`, password: 'long-demo-password' } });
  const group = await api('/chats/groups', {
    cookie: owner.cookie, method: 'POST', body: { name: 'Revocation test', memberIds: [member.user.id] },
  });
  const socket = await connect(member.cookie);
  t.after(() => socket.socket.close());
  socket.send({ type: 'subscribe', kind: 'GROUP', chatId: group.id, lastAppliedSequence: '0' });
  await socket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);

  compose('stop', 'messenger-command-processor');
  t.after(() => compose('up', '-d', '--no-deps', 'messenger-command-processor'));
  const requestId = ulid();
  socket.send({ type: 'send', chatId: group.id, requestId, body: 'Queued before removal' });
  await socket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await api(`/chats/${group.id}/members/${member.user.id}`, {
    cookie: owner.cookie, method: 'DELETE',
  });
  compose('up', '-d', '--no-deps', 'messenger-command-processor');

  let finalStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${apiBase}/v1/sends/${requestId}`, {
      headers: { cookie: member.cookie },
    });
    assert.equal(response.status, 200);
    finalStatus = await response.json();
    if (finalStatus.status === 'REJECTED') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(finalStatus, 'queued request did not reach a durable result');
  assert.equal(finalStatus.status, 'REJECTED');
  assert.equal(finalStatus.reason, 'NOT_A_MEMBER');
  const unknownResponse = await fetch(`${apiBase}/v1/sends/${ulid()}`, {
    headers: { cookie: member.cookie },
  });
  assert.equal(unknownResponse.status, 200);
  assert.equal((await unknownResponse.json()).status, 'UNKNOWN');
  const history = await api(`/chats/${group.id}/messages?afterSeq=0`, { cookie: owner.cookie });
  assert.deepEqual(history.messages, []);
});
