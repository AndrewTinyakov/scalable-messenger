import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Measurements } from './transport.mjs';
import { ulid } from '../support/fixtures.mjs';

function gate() {
  let release;
  let entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  return { release, entered, blocked, requested };
}

function fixture() {
  const chatId = ulid();
  const otherId = ulid();
  const userId = ulid();
  const state = new Run({ chats: [] }, { devices: [[{ userId }]], chats: [chatId, otherId] }, {
    options: {}, controller: new AbortController(),
  }, new Measurements());
  const device = state.devices[0][0];
  const chat = { id: chatId, kind: 'DIRECT', members: [] };
  const other = { id: otherId, kind: 'DIRECT', members: [] };
  device.selected = chat;
  const row = (sequence, body = 'row-' + sequence, version = '1') => ({ id: ulid(), chatId, senderId: userId, sequence: String(sequence), body, messageVersion: version });
  return { state, device, chatId, otherId, userId, chat, other, row };
}

for (const kind of ['edit', 'delete', 'selfDelete']) {
  test('a handoff page retries after the reopened view applies a newer ' + kind, { timeout: 10_000 }, async () => {
    const { state, device, chatId, otherId, chat, other, row } = fixture();
    const anchor = row(95);
    const target = row(100);
    const changed = { ...target, body: 'edited-at-101', messageVersion: '2' };
    const view = device.view(chatId);
    Object.assign(view, { messages: [anchor, target], loaded: true, baseline: '99', mutation: '0', changesAfter: '99', changesSelection: 0 });
    const page = gate();
    const cursors = [];
    let committed = false;
    device.get = async (path, args) => {
      if (path === '/chats') return { chats: [] };
      const isOther = path.includes(otherId);
      if (path.endsWith('/state')) return { lastSeq: kind === 'selfDelete' ? '100' : '101', mutationSeq: kind === 'selfDelete' ? '0' : '101', visibilitySeq: kind === 'selfDelete' ? '1' : '0', memberSeq: kind === 'selfDelete' ? '1' : '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
      if (path.endsWith('/messages/around')) return { messages: [anchor, target], anchorMessageId: anchor.id, mutationSeq: '0' };
      if (path.endsWith('/messages/changes')) {
        if (isOther) return { lastSeq: '0', nextSeq: '0', resetRequired: false, changes: [] };
        const seq = committed && kind !== 'selfDelete' ? '101' : '100';
        const change = kind === 'edit' ? { kind: 'UPSERT', seq, sequence: '100', messageId: target.id, message: changed } : { kind: 'REMOVED', seq, sequence: '100', messageId: target.id };
        return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: committed && kind !== 'selfDelete' && args.afterSeq !== seq ? [change] : [] };
      }
      assert.match(path, /\/messages$/);
      if (args?.afterSeq) {
        cursors.push(args.afterSeq);
        if (cursors.length === 1) {
          page.entered();
          await page.blocked;
          return { messages: [target], coverageThroughSequence: '100', snapshotSequence: '100', visibilitySeq: '0', nextSequence: '100', hasMore: false };
        }
        return { messages: kind === 'edit' ? [changed] : [], coverageThroughSequence: kind === 'selfDelete' ? '100' : '101', snapshotSequence: kind === 'selfDelete' ? '100' : '101', visibilitySeq: kind === 'selfDelete' ? '1' : '0', nextSequence: kind === 'selfDelete' ? '100' : '101', hasMore: false };
      }
      if (kind === 'selfDelete' && !isOther) return { messages: [anchor], coverageThroughSequence: '100', mutationSeq: '0', visibilitySeq: '1' };
      assert.equal(isOther, true);
      return { messages: [], coverageThroughSequence: '0', mutationSeq: '0', visibilitySeq: '0' };
    };
    device.change = async path => {
      assert.match(path, /\/messages\/resolve$/);
      return { messages: [anchor] };
    };
    const recovering = device.catchUp(chatId, '100');
    await page.requested;
    view.detached = anchor;
    await device.openChat(other, performance.now());
    await device.openChat(chat, performance.now());
    while (state.background.size) await Promise.all([...state.background]);
    committed = true;
    device.onFrame({ type: kind === 'edit' ? 'message_changed' : 'history_changed', chatId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(view.changesAfter, kind === 'selfDelete' ? '100' : '101');
    page.release();
    await recovering;
    while (state.background.size) await Promise.all([...state.background]);
    assert.deepEqual(cursors, ['99', '99']);
    assert.equal(view.baseline, kind === 'selfDelete' ? '100' : '101');
    assert.equal(view.messages[0].id, anchor.id);
    assert.equal(view.messages.find(message => message.id === target.id)?.body, kind === 'edit' ? 'edited-at-101' : undefined);
    assert.equal(view.changesAfter, kind === 'selfDelete' ? '100' : '101');
    assert.deepEqual(Object.keys(state.metrics.failures), []);
  });
}

test('handoff retains the new anchor and one page budget at the pagination limit', { timeout: 10_000 }, async () => {
  const { state, device, chatId, otherId, chat, other, row } = fixture();
  const anchorRows = Array.from({ length: 50 }, (_, i) => row(i + 1));
  const view = device.view(chatId);
  Object.assign(view, { messages: [row(99)], loaded: true, baseline: '99', mutation: '0', changesAfter: '99', changesSelection: 0 });
  const twentieth = gate();
  const around = gate();
  let pageRequests = 0;
  let latestRequests = 0;
  let completed = false;
  device.get = async (path, args) => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/messages/changes')) {
      const seq = isOther ? '0' : '1200';
      return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: [] };
    }
    if (path.endsWith('/messages/around')) {
      around.entered();
      await around.blocked;
      return { messages: anchorRows, anchorMessageId: anchorRows[0].id, mutationSeq: '2' };
    }
    assert.match(path, /\/messages$/);
    if (args?.afterSeq) {
      pageRequests++;
      const start = Number(args.afterSeq) + 1;
      const end = start + 49;
      if (pageRequests === 20) { twentieth.entered(); await twentieth.blocked; }
      return { messages: Array.from({ length: 50 }, (_, i) => row(start + i)), coverageThroughSequence: String(end), snapshotSequence: '1200', visibilitySeq: '0', nextSequence: String(end), hasMore: true };
    }
    if (!isOther) latestRequests++;
    return { messages: isOther ? [] : Array.from({ length: 50 }, (_, i) => row(1151 + i)), coverageThroughSequence: isOther ? '0' : '1200', mutationSeq: isOther ? '0' : '1200', visibilitySeq: '0' };
  };
  const result = device.catchUp(chatId, '1100').then(() => { completed = true; return null; }, error => { completed = true; return error; });
  await twentieth.requested;
  view.detached = anchorRows[0];
  await device.openChat(other, performance.now());
  const opening = device.openChat(chat, performance.now());
  await around.requested;
  twentieth.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(latestRequests, 0);
  around.release();
  await opening;
  const error = await result;
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(error?.code, 'catchUpGap');
  assert.equal(pageRequests, 20);
  assert.equal(latestRequests, 0);
  assert.equal(view.messages.length, 50);
  assert.equal(view.messages[0].id, anchorRows[0].id);
  assert.equal(view.detached.id, anchorRows[0].id);
  assert.equal(view.changesSelection, device.selection);
});
