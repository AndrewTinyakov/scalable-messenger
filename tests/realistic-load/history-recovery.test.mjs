import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Fault, Measurements } from './transport.mjs';
import { ulid } from '../support/fixtures.mjs';

for (const trigger of ['disconnect during initial history', 'failed reopen with cached history']) {
  test('selected history recovery repairs mutation cursor after ' + trigger, async () => {
    const chatId = ulid();
    const otherId = ulid();
    const userId = ulid();
    const original = { id: ulid(), chatId, senderId: ulid(), sequence: '1', messageVersion: '1', body: 'original' };
    const state = new Run({ chats: [], profile: { timing: { lagLimitMs: 1500 } } }, {
      devices: [[{ userId }]], chats: [chatId, otherId],
    }, { options: {}, controller: new AbortController() }, new Measurements());
    const device = state.devices[0][0];
    const chat = { id: chatId, kind: 'DIRECT', members: [{ id: userId }] };
    let version = 1;
    let failNext = false;
    let release;
    let entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const requested = new Promise(resolve => { entered = resolve; });
    let blockFirst = trigger === 'disconnect during initial history';
    let snapshots = 0;
    let changes = 0;
    const sequence = () => String(version);
    const currentMessage = () => ({ ...original, messageVersion: sequence(), body: version === 1 ? 'original' : 'edited-' + version });
    device.get = async (path, args) => {
      const other = path.includes(otherId);
      const seq = other ? '0' : sequence();
      if (path.endsWith('/state')) return { lastSeq: seq, mutationSeq: seq, memberSeq: '0', visibilitySeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
      if (path.endsWith('/messages/changes')) {
        changes++;
        return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: !other && args.afterSeq !== seq ? [{ kind: 'UPSERT', seq, sequence: '1', messageId: original.id, message: currentMessage() }] : [] };
      }
      assert.match(path, /\/messages$/);
      if (failNext) { failNext = false; throw new Fault('invalidJson'); }
      if (args.afterSeq) return { messages: [], coverageThroughSequence: seq, nextSequence: seq, hasMore: false };
      snapshots++;
      const message = currentMessage();
      if (blockFirst) { blockFirst = false; entered(); await blocked; }
      return { messages: other ? [] : [message], coverageThroughSequence: seq, mutationSeq: seq, visibilitySeq: '0' };
    };
    device.offerWatch = () => {};
    if (trigger === 'disconnect during initial history') {
      const opening = device.openChat(chat, performance.now());
      await requested;
      await device.disconnect();
      release();
      await opening;
      assert.equal(device.view(chatId).loaded, true);
      assert.equal(device.view(chatId).changesAfter, null);
    } else {
      await device.openChat(chat, performance.now());
      while (state.background.size) await Promise.all([...state.background]);
      await device.openChat({ id: otherId, kind: 'DIRECT', members: [] }, performance.now());
      while (state.background.size) await Promise.all([...state.background]);
      failNext = true;
      await assert.rejects(device.openChat(chat, performance.now()), { code: 'invalidJson' });
      assert.equal(device.view(chatId).loaded, true);
      assert.equal(device.view(chatId).changesAfter, null);
    }
    version = 2;
    device.connect = async () => {
      device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send() {}, async close() { this.ws.readyState = WebSocket.CLOSED; } };
    };
    await state.perform({ type: 'reconnect', actor: 0, device: 0, chat: 0 }, performance.now());
    while (state.background.size) await Promise.all([...state.background]);
    assert.equal(device.view(chatId).baseline, '2');
    assert.equal(device.view(chatId).changesAfter, '2');
    assert.equal(device.view(chatId).messages[0].body, 'edited-2');
    assert.equal(device.view(chatId).messages[0].messageVersion, '2');
    assert.ok(snapshots >= 2);
    version = 3;
    device.onFrame({ type: 'message_changed', chatId });
    while (state.background.size) await Promise.all([...state.background]);
    assert.equal(device.view(chatId).changesAfter, '3');
    assert.equal(device.view(chatId).messages[0].body, 'edited-3');
    assert.equal(device.view(chatId).messages[0].messageVersion, '3');
    assert.ok(changes >= 2);
    assert.deepEqual(Object.keys(state.metrics.failures), []);
    await device.close();
  });
}

for (const replacement of [true, false]) {
test('a failed reopen ends recovery or repairs its cursor depending on a replacement window: ' + replacement, { timeout: 10_000 }, async () => {
  const chatId = ulid();
  const otherId = ulid();
  const userId = ulid();
  const rows = [1, 2].map(sequence => ({ id: ulid(), chatId, senderId: userId, sequence: String(sequence), messageVersion: '1', body: 'row-' + sequence }));
  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId, otherId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [] };
  const other = { id: otherId, kind: 'DIRECT', members: [] };
  device.selected = chat;
  const view = device.view(chatId);
  Object.assign(view, { messages: [rows[0]], loaded: true, baseline: '1', mutation: '1', changesAfter: '1', changesSelection: 0, installedWindow: { selection: 0 } });
  let enter;
  let release;
  const requested = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let failNext = false;
  let requests = 0;
  let snapshots = 0;
  device.get = async (path, args) => {
    requests++;
    const isOther = path.includes(otherId);
    const seq = isOther ? '0' : '2';
    if (path.endsWith('/state')) return { lastSeq: seq, mutationSeq: seq, memberSeq: '0', visibilitySeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: [] };
    assert.match(path, /\/messages$/);
    if (args?.afterSeq) {
      enter();
      await blocked;
      return { messages: [rows[1]], coverageThroughSequence: '2', snapshotSequence: '2', visibilitySeq: '0', nextSequence: '2', hasMore: false };
    }
    if (!isOther && failNext) { failNext = false; throw new Fault('http503'); }
    if (!isOther) snapshots++;
    return { messages: isOther ? [] : rows, coverageThroughSequence: seq, mutationSeq: seq, visibilitySeq: '0' };
  };
  const load = device.loadCatchUp.bind(device);
  let iterations = 0;
  device.loadCatchUp = (...args) => {
    if (++iterations > 5) throw new Fault('recoveryRepeatedWithoutProgress');
    return load(...args);
  };
  const recovering = device.catchUp(chatId, '2');
  const outcome = replacement ? assert.rejects(recovering, { code: 'catchUpCursorMissing' }) : recovering;
  await requested;
  await device.openChat(other, performance.now());
  if (replacement) await device.openChat(chat, performance.now());
  while (state.background.size) await Promise.all([...state.background]);
  const installation = view.installedWindow;
  if (replacement) await device.openChat(other, performance.now());
  failNext = true;
  await assert.rejects(device.openChat(chat, performance.now()), { code: 'http503' });
  assert.equal(view.changesAfter, null);
  const before = requests;
  const snapshotsBefore = snapshots;
  release();
  await outcome;
  if (replacement) assert.equal(requests, before);
  assert.equal(snapshots - snapshotsBefore, replacement ? 0 : 1);
  assert.equal(view.catchingUp, null);
  if (replacement) assert.equal(view.installedWindow, installation);
  else assert.equal(view.changesAfter, '2');
  assert.deepEqual(view.messages.map(message => message.id), rows.map(message => message.id));
  await device.sync(chatId, { primary: true });
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(view.changesAfter, '2');
  assert.equal(view.baseline, '2');
  assert.deepEqual(view.messages.map(message => message.id), rows.map(message => message.id));
});
}
