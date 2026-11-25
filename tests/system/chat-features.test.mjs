import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { api, csrfHeaders } from '../support/api-client.mjs';
import { ulid } from '../support/fixtures.mjs';
import { apiBase } from '../support/runtime.mjs';
import { connect } from '../support/socket-client.mjs';

async function status(path, cookie, method = 'GET', body) {
  const response = await fetch(`${apiBase}/v1${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { cookie, ...csrfHeaders(method), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response.status;
}

function acknowledge(socket, message) {
  socket.send({ type: 'received_message', chatId: message.chatId, sequence: message.sequence });
}

async function saved(sender, receiver, target, body, replyToMessageId) {
  const requestId = ulid();
  sender.send({ type: 'send', ...target, requestId, body, ...(replyToMessageId ? { replyToMessageId } : {}) });
  await sender.waitFor((frame) => frame.type === 'queued' && frame.requestId === requestId);
  const event = await receiver.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  await sender.waitFor((frame) => frame.type === 'message_saved' && frame.requestId === requestId);
  acknowledge(sender, event);
  acknowledge(receiver, event);
  return event;
}

async function waitForPresence(socket, userId, online, after = 0) {
  return socket.waitFor((frame) => frame.type === 'presence' && frame.statuses.some((peer) => peer.userId === userId && peer.online === online), 15000, after);
}

test('chat features preserve live state, human reads, mutation recovery and global deletion', { timeout: 150000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const users = [];
  for (const role of ['author', 'reader', 'outsider']) users.push(await api('/auth/register', {
    method: 'POST', body: { username: `${role}_${suffix}`, password: 'feature-test-password' },
  }));
  const [author, reader, outsider] = users;
  const authorSocket = await connect(author.cookie);
  let readerSocket = await connect(reader.cookie);
  const readerSecond = await connect(reader.cookie);
  const outsiderSocket = await connect(outsider.cookie);
  t.after(() => { for (const client of [authorSocket, readerSocket, readerSecond, outsiderSocket]) client.socket.close(); });

  const first = await saved(authorSocket, readerSocket, { recipientId: reader.user.id }, 'The original message');
  await readerSecond.waitFor((frame) => frame.type === 'message_saved' && frame.messageId === first.messageId);
  acknowledge(readerSecond, first);
  const chatId = first.chatId;
  const base = `/chats/${chatId}`;
  readerSocket.send({ type: 'applied', chatId, sequence: first.sequence });
  assert.equal((await api(`${base}/reads`, { cookie: author.cookie })).maxOtherReadSequence, '0');
  assert.equal((await api(`${base}/messages/${first.messageId}/reads`, { cookie: author.cookie })).readers.length, 0);

  authorSocket.send({ type: 'watch_presence', add: [reader.user.id] });
  await waitForPresence(authorSocket, reader.user.id, true);
  const secondDeviceAt = authorSocket.frames.length;
  readerSecond.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(authorSocket.frames.slice(secondDeviceAt).some((frame) => frame.type === 'presence' && frame.statuses.some((peer) => peer.userId === reader.user.id && !peer.online)), false);
  const offlineAt = authorSocket.frames.length;
  readerSocket.socket.close();
  const offline = await waitForPresence(authorSocket, reader.user.id, false, offlineAt);
  assert.ok(Date.parse(offline.statuses.find((peer) => peer.userId === reader.user.id).lastSeenAt) > 0);
  const onlineAt = authorSocket.frames.length;
  readerSocket = await connect(reader.cookie);
  await waitForPresence(authorSocket, reader.user.id, true, onlineAt);

  const progress = await api(`${base}/reads`, { cookie: reader.cookie, method: 'POST', body: { throughSequence: first.sequence } });
  const details = await api(`${base}/messages/${first.messageId}/reads`, { cookie: author.cookie });
  assert.equal(details.detailsAvailable, true);
  assert.deepEqual(details.readers.map((entry) => entry.userId), [reader.user.id]);
  assert.equal(Date.parse(details.readers[0].readAt), Date.parse(progress.readAt));
  assert.equal((await api(`${base}/reads`, { cookie: author.cookie })).maxOtherReadSequence, first.sequence);
  const repeated = await api(`${base}/reads`, { cookie: reader.cookie, method: 'POST', body: { throughSequence: '0' } });
  assert.equal(repeated.throughSequence, first.sequence);
  assert.equal(Date.parse(repeated.readAt), Date.parse(progress.readAt));
  assert.equal(await status(`${base}/reads`, reader.cookie, 'POST', { throughSequence: 1 }), 400);
  assert.equal(await status(`${base}/reads`, reader.cookie, 'POST', { throughSequence: null }), 400);

  const reply = await saved(authorSocket, readerSocket, { chatId }, 'Reply text', first.messageId);
  assert.equal(reply.replyToMessageId, first.messageId);
  assert.equal(Object.hasOwn(reply, 'replyBody'), false);
  const resolvedReply = await api(`${base}/messages/resolve`, { cookie: reader.cookie, method: 'POST', body: { messageIds: [reply.messageId] } });
  assert.equal(resolvedReply.messages[0].replyBody, first.body);
  assert.equal(resolvedReply.messages[0].replyDeleted, false);
  const editAt = readerSocket.frames.length;
  const edited = await api(`${base}/messages/${first.messageId}`, { cookie: author.cookie, method: 'PATCH', body: { body: 'Edited original', expectedVersion: '1' } });
  assert.equal(edited.messageVersion, '2');
  await readerSocket.waitFor((frame) => frame.type === 'history_changed' && frame.chatId === chatId && frame.mutationRevision === '1', 20000, editAt);
  assert.equal((await api(`${base}/messages`, { cookie: reader.cookie })).messages.find((message) => message.id === reply.messageId).replyBody, edited.body);
  assert.equal(await status(`${base}/messages/${first.messageId}`, reader.cookie, 'PATCH', { body: 'Foreign edit', expectedVersion: '2' }), 403);
  assert.equal(await status(`${base}/messages/${first.messageId}`, author.cookie, 'PATCH', { body: 'Stale edit', expectedVersion: '1' }), 409);

  const deletionAt = readerSocket.frames.length;
  const deleted = await api(`${base}/deletions`, { cookie: author.cookie, method: 'POST', body: {
    requestId: ulid(), scope: 'EVERYONE', target: 'MESSAGES', messageIds: [first.messageId],
  } });
  assert.equal(deleted.state, 'COMPLETED');
  assert.equal(deleted.deletedRows, '1');
  await readerSocket.waitFor((frame) => frame.type === 'history_changed' && frame.chatId === chatId && frame.mutationRevision === '2', 20000, deletionAt);
  assert.equal(await status(`${base}/messages/around?messageId=${first.messageId}&limit=50`, reader.cookie), 404);
  const around = await api(`${base}/messages/around?messageId=${reply.messageId}&limit=50`, { cookie: reader.cookie });
  assert.equal(around.anchorMessageId, reply.messageId);
  assert.equal(around.messages.some((message) => message.id === first.messageId), false);
  const currentReply = around.messages.find((message) => message.id === reply.messageId);
  assert.equal(currentReply.replyToMessageId, first.messageId);
  assert.equal(currentReply.replySenderId, null);
  assert.equal(currentReply.replyBody, null);
  assert.equal(await status(`${base}/messages/${first.messageId}/reads`, author.cookie), 404);
  const changes = await api(`${base}/messages/changes?afterRevision=0&limit=100`, { cookie: reader.cookie });
  assert.deepEqual(changes.changes.map((change) => change.revision), ['1', '2']);
  assert.ok(changes.changes.every((change) => change.kind === 'REMOVED' && change.messageId === first.messageId && change.message === null));
  const invalidRequest = ulid();
  authorSocket.send({ type: 'send', chatId, requestId: invalidRequest, body: 'Deleted target', replyToMessageId: first.messageId });
  await authorSocket.waitFor((frame) => frame.type === 'send_rejected' && frame.requestId === invalidRequest && frame.reason === 'INVALID_REPLY_TARGET');
  assert.equal((await api(`${base}/messages`, { cookie: author.cookie })).messages.length, 1);

  await api(base, { cookie: reader.cookie, method: 'DELETE' });
  await authorSocket.waitFor((frame) => frame.type === 'chat_deleted' && frame.chatId === chatId);
  await readerSocket.waitFor((frame) => frame.type === 'chat_deleted' && frame.chatId === chatId);
  assert.equal(await status(base, author.cookie), 404);
  assert.equal(await status(`${base}/messages`, reader.cookie), 404);
  const reopened = await saved(authorSocket, readerSocket, { recipientId: reader.user.id }, 'A new conversation');
  assert.notEqual(reopened.chatId, chatId);
  assert.equal(reopened.sequence, '1');

  const group = await api('/chats/groups', { cookie: author.cookie, method: 'POST', body: { name: `Features ${suffix}`, memberIds: [reader.user.id] } });
  for (const client of [authorSocket, readerSocket]) {
    client.send({ type: 'subscribe', chatId: group.id, kind: 'GROUP' });
    await client.waitFor((frame) => frame.type === 'subscribed' && frame.chatId === group.id);
  }
  await saved(authorSocket, readerSocket, { chatId: group.id }, 'A group message');
  assert.equal(await status(`/chats/${group.id}`, reader.cookie, 'DELETE'), 403);
  outsiderSocket.send({ type: 'watch_presence', add: [author.user.id] });
  await outsiderSocket.waitFor((frame) => frame.type === 'presence' && frame.unavailable?.includes(author.user.id));
  authorSocket.send({ type: 'watch_online_count', chatId: group.id });
  await authorSocket.waitFor((frame) => frame.type === 'online_count' && frame.chatId === group.id && frame.online === 2 && frame.members === 2);
  outsiderSocket.send({ type: 'watch_online_count', chatId: group.id });
  await outsiderSocket.waitFor((frame) => frame.type === 'error' && frame.code === 'UNAUTHORIZED');
  await api(`/chats/${group.id}`, { cookie: author.cookie, method: 'DELETE' });
  for (const client of [authorSocket, readerSocket]) await client.waitFor((frame) => frame.type === 'chat_deleted' && frame.chatId === group.id);
  assert.equal(await status(`/chats/${group.id}/messages`, reader.cookie), 404);
  assert.equal((await api('/chats', { cookie: reader.cookie })).chats.some((chat) => chat.id === group.id), false);
});
