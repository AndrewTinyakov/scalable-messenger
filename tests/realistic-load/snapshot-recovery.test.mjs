import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Fault, Measurements } from './transport.mjs';
import { ulid } from '../support/fixtures.mjs';

for (const liveCount of [1, 101, 170]) {
test('a reconnect snapshot retains acknowledged live rows within the cache limit: ' + liveCount, { timeout: 10_000 }, async () => {
  const chatId = ulid();
  const userId = ulid();
  const senderId = ulid();
  const first = { id: ulid(), chatId, senderId, sequence: '1', messageVersion: '1', body: 'snapshot' };

  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [{ id: senderId, username: 'peer' }], lastSequence: '1' };
  device.selected = chat;
  device.directory = [chat];
  device.phase = 'open';
  Object.assign(device.view(chatId), { messages: [first], loaded: true, baseline: '1', dismissed: '1', mutation: '1', changesAfter: null });
  const frames = [];
  device.connect = async () => {
    device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send(frame) { frames.push(frame); }, async close() { this.ws.readyState = WebSocket.CLOSED; } };
  };
  device.offerWatch = () => {};
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  let current = '1';
  device.get = async path => {
    if (path.endsWith('/state')) return { lastSeq: current, mutationSeq: '1', visibilitySeq: '0', memberSeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) return { lastSeq: '1', nextSeq: '1', resetRequired: false, changes: [] };
    assert.match(path, /\/messages$/);
    entered();
    await blocked;
    return { messages: [first], coverageThroughSequence: '1', mutationSeq: '1', visibilitySeq: '0' };
  };
  const reconnect = state.perform({ type: 'reconnect', actor: 0, device: 0, chat: 0 }, performance.now());
  await requested;
  current = String(liveCount + 1);
  for (let i = 0; i < liveCount; i++) device.onFrame({ version: 1, type: 'message_saved', chatId, messageId: ulid(), senderId, sequence: String(i + 2), messageVersion: '1', body: 'live' });
  assert.ok(frames.some(frame => frame.type === 'applied' && frame.sequence === current));
  release();
  await reconnect;
  while (state.background.size) await Promise.all([...state.background]);
  await device.sync(chatId, { primary: true });
  assert.equal(device.view(chatId).baseline, current);
  assert.equal(device.view(chatId).changesAfter, '1');
  assert.deepEqual(device.view(chatId).messages.map(message => message.sequence), Array.from({ length: liveCount + 1 }, (_, i) => String(i + 1)).slice(-150));
  assert.deepEqual(Object.keys(state.metrics.failures), []);
  await device.close();
});
}

test('a late recovery snapshot cannot overwrite history installed by a newer open', { timeout: 10_000 }, async () => {
  const chatId = ulid();
  const userId = ulid();
  const senderId = ulid();
  const messageId = ulid();
  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [{ id: senderId }], lastSequence: '1' };
  device.selected = chat;
  Object.assign(device.view(chatId), { loaded: true, baseline: '1', mutation: '1', changesAfter: null });
  device.connect = async () => {
    device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send() {}, async close() { this.ws.readyState = WebSocket.CLOSED; } };
  };
  device.offerWatch = () => {};
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  let version = '2';
  let snapshots = 0;
  device.get = async path => {
    if (path.endsWith('/state')) return { lastSeq: version, mutationSeq: version, visibilitySeq: '0', memberSeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) return { lastSeq: version, nextSeq: version, resetRequired: false, changes: [] };
    assert.match(path, /\/messages$/);
    const snapshot = { messages: [{ id: messageId, chatId, senderId, sequence: '1', messageVersion: version, body: 'version-' + version }], coverageThroughSequence: version, mutationSeq: version, visibilitySeq: '0' };
    if (++snapshots === 1) { entered(); await blocked; }
    return snapshot;
  };
  const reconnect = state.perform({ type: 'reconnect', actor: 0, device: 0, chat: 0 }, performance.now());
  await requested;
  version = '3';
  await device.openChat(chat, performance.now());
  assert.equal(device.view(chatId).messages[0].messageVersion, '3');
  release();
  await reconnect;
  while (state.background.size) await Promise.all([...state.background]);
  await device.sync(chatId, { primary: true });
  const view = device.view(chatId);
  assert.equal(view.baseline, '3');
  assert.equal(view.mutation, '3');
  assert.equal(view.changesAfter, '3');
  assert.equal(view.messages[0].body, 'version-3');
  assert.equal(view.messages[0].messageVersion, '3');
  assert.deepEqual(Object.keys(state.metrics.failures), []);
  await device.close();
});

test('changing chats does not discard a valid snapshot for the earlier chat', { timeout: 10_000 }, async () => {
  const chatId = ulid();
  const otherId = ulid();
  const userId = ulid();
  const rows = [1, 2, 3].map(sequence => ({ id: ulid(), chatId, senderId: userId, sequence: String(sequence), messageVersion: '1', body: 'row-' + sequence }));
  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId, otherId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [{ id: userId }] };
  const other = { id: otherId, kind: 'DIRECT', members: [{ id: userId }] };
  device.selected = chat;
  Object.assign(device.view(chatId), { messages: rows.slice(0, 2), loaded: true, baseline: '2', mutation: '2', changesAfter: '2', changesSelection: 0, detached: rows[0] });
  device.connect = async () => {
    device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send() {}, async close() { this.ws.readyState = WebSocket.CLOSED; } };
  };
  device.offerWatch = () => {};
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  let snapshots = 0;
  device.get = async path => {
    const isOther = path.includes(otherId);
    const seq = isOther ? '0' : '3';
    if (path.endsWith('/state')) return { lastSeq: seq, mutationSeq: '0', visibilitySeq: '0', memberSeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: [] };
    assert.match(path, /\/messages$/);
    if (!isOther) { snapshots++; entered(); await blocked; }
    return { messages: isOther ? [] : rows, coverageThroughSequence: seq, mutationSeq: '0', visibilitySeq: '0' };
  };
  device.onFrame({ type: 'recovery_failed', chatId });
  await requested;
  const reconnect = state.perform({ type: 'reconnect', actor: 0, device: 0, chat: 0 }, performance.now());
  await new Promise(resolve => setImmediate(resolve));
  await device.openChat(other, performance.now());
  release();
  await reconnect;
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(snapshots, 1);
  assert.equal(device.selected.id, otherId);
  assert.equal(device.view(chatId).baseline, '3');
  assert.deepEqual(device.view(chatId).messages.map(message => message.sequence), ['1', '2', '3']);
  assert.deepEqual(Object.keys(state.metrics.failures), []);
  await device.close();
});

for (const recoverable of [true, false]) {
  test('stale snapshots ' + (recoverable ? 'retry to required coverage' : 'fail after bounded retries without changing cache'), { timeout: 10_000 }, async () => {
    const chatId = ulid();
    const userId = ulid();
    const message = { id: ulid(), chatId, senderId: userId, sequence: '1', messageVersion: '4', body: 'version-4' };
    const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId] }, {
      options: {}, controller: new AbortController(),
    }, new Measurements());
    const device = state.devices[0][0];
    device.selected = { id: chatId };
    const view = device.view(chatId);
    Object.assign(view, { messages: [message], loaded: true, baseline: '1', mutation: '4', changesAfter: '4', changesSelection: 0, detached: message });
    let snapshots = 0;
    device.get = async () => {
      const fresh = ++snapshots > 1 && recoverable;
      return { messages: [{ ...message, messageVersion: fresh ? '4' : '3', body: fresh ? 'version-4' : 'version-3' }],
        coverageThroughSequence: fresh ? '4' : '3', mutationSeq: fresh ? '4' : '3', visibilitySeq: '0' };
    };
    if (recoverable) {
      await device.catchUp(chatId, '3');
      assert.equal(snapshots, 2);
      assert.equal(view.baseline, '4');
    } else {
      await assert.rejects(device.catchUp(chatId, '3'), { code: 'catchUpSnapshotStale' });
      assert.equal(snapshots, 3);
      assert.equal(view.baseline, '1');
    }
    assert.equal(view.messages[0].body, 'version-4');
    assert.equal(view.messages[0].messageVersion, '4');
    assert.equal(view.changesAfter, '4');
  });
}

test('an older changes reset cannot reseed the cursor of a reopened anchor view', { timeout: 10_000 }, async () => {
  const chatId = ulid();
  const otherId = ulid();
  const userId = ulid();
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: ulid(), chatId, senderId: userId, sequence: String(i + 1), messageVersion: '1', body: 'row-' + (i + 1) }));
  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId, otherId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [] };
  const other = { id: otherId, kind: 'DIRECT', members: [] };
  device.selected = chat;
  Object.assign(device.view(chatId), { messages: rows.slice(54), loaded: true, baseline: '100', mutation: '2', changesAfter: '1', changesSelection: 0, detached: rows[0] });
  const gates = Array.from({ length: 3 }, () => {
    let release;
    let entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    return { release, entered, blocked, requested };
  });
  let snapshots = 0;
  let changes = 0;
  device.get = async path => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/state')) return { lastSeq: '100', mutationSeq: '2', visibilitySeq: '0', memberSeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) {
      const seq = isOther ? '0' : '100';
      return { lastSeq: seq, nextSeq: seq, resetRequired: !isOther && ++changes === 1, changes: [] };
    }
    if (path.endsWith('/messages/around')) {
      gates[2].entered();
      await gates[2].blocked;
      return { messages: rows.slice(0, 50), mutationSeq: '2', anchorMessageId: rows[0].id };
    }
    assert.match(path, /\/messages$/);
    if (!isOther) {
      const gate = gates[snapshots++];
      assert.ok(gate);
      gate.entered();
      await gate.blocked;
    }
    return { messages: isOther ? [] : rows.slice(54), coverageThroughSequence: isOther ? '0' : '100', mutationSeq: isOther ? '0' : '2', visibilitySeq: '0' };
  };
  const resetting = device.refreshChanges(chatId);
  await gates[0].requested;
  const catchingUp = device.catchUp(chatId, '100');
  await gates[1].requested;
  await device.openChat(other, performance.now());
  const reopening = device.openChat(chat, performance.now());
  await gates[2].requested;
  gates[0].release();
  await resetting;
  assert.equal(device.view(chatId).changesAfter, null);
  gates[2].release();
  await reopening;
  assert.equal(device.view(chatId).messages[0].sequence, '1');
  gates[1].release();
  await catchingUp;
  while (state.background.size) await Promise.all([...state.background]);
  await device.sync(chatId, { primary: true });
  assert.equal(device.view(chatId).messages[0].sequence, '1');
  assert.equal(device.view(chatId).changesSelection, device.selection);
  assert.equal(device.view(chatId).detached.id, rows[0].id);
  assert.deepEqual(Object.keys(state.metrics.failures), []);
});

for (const resetBeforeAnchor of [true, false]) {
  test('a reset snapshot cannot skip a newer edit when it returns ' + (resetBeforeAnchor ? 'before' : 'after') + ' the reopened anchor', { timeout: 10_000 }, async () => {
    const chatId = ulid();
    const otherId = ulid();
    const userId = ulid();
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: ulid(), chatId, senderId: userId, sequence: String(i + 1), messageVersion: '1', body: 'row-' + (i + 1) }));
    const edited = { ...rows[0], messageVersion: '2', body: 'edited-at-101' };
    const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId, otherId] }, {
      options: {}, controller: new AbortController(),
    }, new Measurements());
    const device = state.devices[0][0];
    const chat = { id: chatId, kind: 'DIRECT', members: [] };
    const other = { id: otherId, kind: 'DIRECT', members: [] };
    device.selected = chat;
    Object.assign(device.view(chatId), { messages: rows.slice(54), loaded: true, baseline: '100', mutation: '2', changesAfter: '1', changesSelection: 0, detached: rows[0] });
    const gates = Array.from({ length: 3 }, () => {
      let release;
      let entered;
      const blocked = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { entered = resolve; });
      return { release, entered, blocked, requested };
    });
    let snapshots = 0;
    let changes = 0;
    let editCommitted = false;
    const cursors = [];
    device.get = async (path, args) => {
      const isOther = path.includes(otherId);
      if (path.endsWith('/messages/changes')) {
        if (isOther) return { lastSeq: '0', nextSeq: '0', resetRequired: false, changes: [] };
        cursors.push(args.afterSeq);
        if (++changes === 1) return { lastSeq: '100', nextSeq: '100', resetRequired: true, changes: [] };
        return { lastSeq: '101', nextSeq: '101', resetRequired: false, changes: args.afterSeq !== '101' ? [{ kind: 'UPSERT', seq: '101', sequence: '1', messageId: edited.id, message: edited }] : [] };
      }
      if (path.endsWith('/messages/around')) {
        gates[2].entered();
        await gates[2].blocked;
        return { messages: rows.slice(0, 50), mutationSeq: '2', anchorMessageId: rows[0].id };
      }
      assert.match(path, /\/messages$/);
      if (!isOther) {
        const gate = gates[snapshots++];
        assert.ok(gate);
        gate.entered();
        await gate.blocked;
      }
      return { messages: isOther ? [] : rows.slice(54), coverageThroughSequence: isOther ? '0' : '101', mutationSeq: isOther ? '0' : editCommitted ? '101' : '2', visibilitySeq: '0' };
    };
    const resetting = device.refreshChanges(chatId);
    await gates[0].requested;
    const catchingUp = device.catchUp(chatId, '100');
    await gates[1].requested;
    await device.openChat(other, performance.now());
    const reopening = device.openChat(chat, performance.now());
    await gates[2].requested;
    editCommitted = true;
    if (resetBeforeAnchor) { gates[0].release(); await resetting; }
    gates[2].release();
    await reopening;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(cursors.includes('2'));
    assert.equal(device.view(chatId).messages[0].body, 'edited-at-101');
    assert.equal(device.view(chatId).changesAfter, '101');
    if (!resetBeforeAnchor) { gates[0].release(); await resetting; }
    gates[1].release();
    await catchingUp;
    while (state.background.size) await Promise.all([...state.background]);
    assert.equal(device.view(chatId).messages[0].sequence, '1');
    assert.equal(device.view(chatId).messages[0].body, 'edited-at-101');
    assert.equal(device.view(chatId).changesSelection, device.selection);
    assert.deepEqual(Object.keys(state.metrics.failures), []);
  });
}
