import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { randomBytes } from 'node:crypto';

test('a confirmed send is saved once and reaches another socket', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const alice = await api('/auth/register', { method: 'POST', body: { username: `alice_${suffix}`, password: 'long-demo-password' } });
  const bob = await api('/auth/register', { method: 'POST', body: { username: `bob_${suffix}`, password: 'long-demo-password' } });
  assert.deepEqual(await api('/chats', { cookie: alice.cookie }), { chats: [] });
  assert.deepEqual(await api('/chats', { cookie: bob.cookie }), { chats: [] });
  const aliceSocket = await connect(alice.cookie);
  const aliceSecondSocket = await connect(alice.cookie);
  const bobSocket = await connect(bob.cookie);
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
  assert.equal((await api('/chats', { cookie: alice.cookie })).chats.length, 1);
  assert.equal((await api('/chats', { cookie: bob.cookie })).chats.length, 1);
  assert.equal((senderDeviceReceived.event ?? senderDeviceReceived).messageId, event.messageId);
  assert.equal(event.body, 'A message across two nodes');
  assert.equal(event.sequence, '1');
  assert.equal(event.senderId, alice.user.id);

  const history = await api(`/chats/${chat.id}/messages?afterSeq=0`, { cookie: bob.cookie });
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, event.messageId);
  const status = await api(`/sends/${requestId}`, { cookie: alice.cookie });
  assert.equal(status.status, 'SAVED');
  assert.equal(status.messageId, event.messageId);

  const group = await api('/chats/groups', {
    cookie: alice.cookie,
    method: 'POST',
    body: { name: 'A second chat', memberIds: [bob.user.id] },
  });
  const { chats: listed } = await api('/chats', { cookie: alice.cookie });
  assert.equal(listed.length, 2);
  assert.equal(listed[0].id, group.id);
  assert.equal(listed[0].lastSequence, '0');
  assert.equal(listed[0].memberCount, 2);
  assert.deepEqual(listed[0].members, []);
  const openedGroup = await api(`/chats/${group.id}`, { cookie: alice.cookie });
  assert.deepEqual(openedGroup.members.map((member) => member.id).sort(), [alice.user.id, bob.user.id].sort());
  assert.equal(listed[1].id, chat.id);
  assert.equal(listed[1].lastSequence, '1');
  assert.deepEqual(listed[1].members.map((member) => member.id).sort(), [alice.user.id, bob.user.id].sort());

  aliceSocket.send({ type: 'send', recipientId: bob.user.id, requestId, body: 'A message across two nodes' });
  await aliceSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const replayedHistory = await api(`/chats/${chat.id}/messages?afterSeq=0`, { cookie: bob.cookie });
  assert.equal(replayedHistory.messages.length, 1);
});
