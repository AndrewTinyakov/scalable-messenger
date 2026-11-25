import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { api } from '../support/api-client.mjs';
import { connect } from '../support/socket-client.mjs';

function status(socket, userId, after = 0) {
  return socket.waitFor((frame) => frame.type === 'presence' && frame.statuses.some((peer) => peer.userId === userId), 15000, after)
    .then((frame) => frame.statuses.find((peer) => peer.userId === userId));
}

test('presence follows activity, hides strangers and counts small groups', { timeout: 90000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const [alice, bob, stranger] = await Promise.all(['alice', 'bob', 'stranger'].map((role) => api('/auth/register', {
    method: 'POST', body: { username: `${role}_${suffix}`, password: 'presence-test-password' },
  })));
  const group = await api('/chats/groups', { cookie: alice.cookie, method: 'POST', body: { name: `Presence ${suffix}`, memberIds: [bob.user.id] } });
  const watcher = await connect(alice.cookie);
  const strangerSocket = await connect(stranger.cookie);
  let bobSocket = await connect(bob.cookie);
  t.after(() => { for (const client of [watcher, strangerSocket, bobSocket]) client.socket.close(); });

  assert.equal((await watcher.waitFor((frame) => frame.type === 'presence_config')).idleAfterHiddenMs, 5000);
  watcher.send({ type: 'watch_presence', reset: true, add: [bob.user.id] });
  assert.equal((await status(watcher, bob.user.id)).online, true);

  let at = watcher.frames.length;
  bobSocket.send({ type: 'activity', active: false, visible: false });
  const idle = await status(watcher, bob.user.id, at);
  assert.equal(idle.online, false);
  assert.ok(Date.parse(idle.lastSeenAt) > 0);
  at = watcher.frames.length;
  bobSocket.send({ type: 'activity', active: true, visible: true });
  assert.equal((await status(watcher, bob.user.id, at)).online, true);

  at = watcher.frames.length;
  bobSocket.socket.close();
  assert.equal((await status(watcher, bob.user.id, at)).online, false);
  at = watcher.frames.length;
  bobSocket = await connect(bob.cookie);
  assert.equal((await status(watcher, bob.user.id, at)).online, true);

  strangerSocket.send({ type: 'watch_presence', add: [alice.user.id] });
  const hidden = await strangerSocket.waitFor((frame) => frame.type === 'presence' && frame.unavailable?.includes(alice.user.id));
  assert.equal(hidden.statuses.length, 0);

  watcher.send({ type: 'watch_online_count', chatId: group.id });
  await watcher.waitFor((frame) => frame.type === 'online_count' && frame.chatId === group.id && frame.online === 2 && frame.members === 2);
  at = watcher.frames.length;
  bobSocket.socket.close();
  await watcher.waitFor((frame) => frame.type === 'online_count' && frame.chatId === group.id && frame.online === 1, 15000, at);
  strangerSocket.send({ type: 'watch_online_count', chatId: group.id });
  await strangerSocket.waitFor((frame) => frame.type === 'error' && frame.code === 'UNAUTHORIZED');
});
