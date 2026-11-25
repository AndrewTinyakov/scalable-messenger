import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { apiBase } from '../support/runtime.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { randomBytes } from 'node:crypto';

test('group members receive saved events and removed members lose history access', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `member_${suffix}`, password: 'long-demo-password' } });
  const other = await api('/auth/register', { method: 'POST', body: { username: `other_${suffix}`, password: 'long-demo-password' } });
  const ownerSocket = await connect(owner.cookie);
  const memberSocket = await connect(member.cookie);
  const otherSocket = await connect(other.cookie);
  t.after(() => { ownerSocket.socket.close(); memberSocket.socket.close(); otherSocket.socket.close(); });
  const group = await api('/chats/groups', {
    cookie: owner.cookie,
    method: 'POST',
    body: { name: 'System test group', memberIds: [member.user.id, other.user.id] },
  });
  for (const client of [ownerSocket, memberSocket, otherSocket]) {
    await client.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === group.id);
  }
  assert.equal((await api('/chats', { cookie: member.cookie })).chats.length, 1);

  for (const client of [ownerSocket, memberSocket, otherSocket]) {
    client.send({ type: 'subscribe', kind: 'GROUP', chatId: group.id, lastAppliedSequence: '0' });
    await client.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);
  }
  const requestId = ulid();
  ownerSocket.send({ type: 'send', chatId: group.id, requestId, body: 'For the whole group' });
  await ownerSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  await memberSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  await otherSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);

  await api(`/chats/${group.id}/members/${member.user.id}`, { cookie: owner.cookie, method: 'DELETE' });
  const historyResponse = await fetch(`${apiBase}/v1/chats/${group.id}/messages?afterSeq=0`, {
    headers: { cookie: member.cookie },
  });
  assert.ok([403, 404].includes(historyResponse.status), `removed member still fetched history: ${historyResponse.status}`);
  await memberSocket.waitFor((frame) => frame.type === 'member_removed' && frame.chatId === group.id, 15000);
  const afterRemoval = memberSocket.frames.length;
  memberSocket.send({ type: 'subscribe', kind: 'GROUP', chatId: group.id });
  await memberSocket.waitFor((frame) => frame.type === 'error' && frame.code === 'UNAUTHORIZED', 15000, afterRemoval);
  const rejectedRequestId = ulid();
  memberSocket.send({ type: 'send', chatId: group.id, requestId: rejectedRequestId, body: 'After removal' });
  await memberSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === rejectedRequestId);
  await memberSocket.waitFor((frame) => frame.type === 'send_rejected' && frame.requestId === rejectedRequestId);

  const nextRequestId = ulid();
  otherSocket.send({ type: 'send', chatId: group.id, requestId: nextRequestId, body: 'Still here' });
  await ownerSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === nextRequestId);
  const history = await api(`/chats/${group.id}/messages?afterSeq=0`, { cookie: owner.cookie });
  assert.deepEqual(history.messages.map((message) => message.body), ['For the whole group', 'Still here']);

  const readdStart = memberSocket.frames.length;
  const ownerAddStart = ownerSocket.frames.length;
  const otherAddStart = otherSocket.frames.length;
  await api(`/chats/${group.id}/members`, {
    cookie: owner.cookie, method: 'POST', body: { memberIds: [member.user.id] },
  });
  await memberSocket.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === group.id, 15000, readdStart);
  for (const [client, start] of [[ownerSocket, ownerAddStart], [otherSocket, otherAddStart]]) {
    const changed = await client.waitFor((frame) => frame.type === 'membership_changed' && frame.chatId === group.id, 15000, start);
    assert.equal(changed.room, `group:${group.id}`);
  }
  const resubscribeStart = memberSocket.frames.length;
  memberSocket.send({ type: 'subscribe', kind: 'GROUP', chatId: group.id });
  await memberSocket.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id, 15000, resubscribeStart);
  const rejoinedRequestId = ulid();
  memberSocket.send({ type: 'send', chatId: group.id, requestId: rejoinedRequestId, body: 'Rejoined group' });
  await otherSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === rejoinedRequestId);
});

test('an existing socket subscribes to a batch of groups created after login', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const owner = await api('/auth/register', { method: 'POST', body: { username: `batch_owner_${suffix}`, password: 'long-demo-password' } });
  const member = await api('/auth/register', { method: 'POST', body: { username: `batch_member_${suffix}`, password: 'long-demo-password' } });
  const ownerSocket = await connect(owner.cookie);
  const memberSocket = await connect(member.cookie);
  t.after(() => { ownerSocket.socket.close(); memberSocket.socket.close(); });
  const groups = [];
  for (const name of ['First batch group', 'Second batch group']) {
    groups.push(await api('/chats/groups', {
      cookie: owner.cookie,
      method: 'POST',
      body: { name, memberIds: [member.user.id] },
    }));
  }
  for (const group of groups) {
    await memberSocket.waitFor((frame) => frame.type === 'chat_created' && frame.chatId === group.id);
  }
  const subscriptions = groups.map((group) => ({ chatId: group.id, kind: 'GROUP', lastAppliedSequence: '0' }));
  for (const client of [ownerSocket, memberSocket]) {
    client.send({ type: 'subscribe_many', subscriptions });
    for (const group of groups) {
      await client.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);
    }
  }
  for (const group of groups) {
    const requestId = ulid();
    ownerSocket.send({ type: 'send', chatId: group.id, requestId, body: `Hello ${group.name}` });
    await ownerSocket.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
    const received = await memberSocket.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
    const saved = received.event ?? received;
    assert.equal(saved.chatId, group.id);
    assert.equal(saved.sequence, '1');
  }
});
