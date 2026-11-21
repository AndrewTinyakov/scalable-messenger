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

for (const ordering of ['selected', 'left while loading', 'opened after protection', 'jumped after disconnect', 'jumped during fallback', 'jumped in same selection during fallback', 'jumped in same selection during page', 'jumped in same selection during final fallback']) {
test('handoff retains the new anchor and one page budget at the pagination limit: ' + ordering, { timeout: 10_000 }, async () => {
  const { state, device, chatId, otherId, chat, other, row } = fixture();
  const anchorRows = Array.from({ length: 50 }, (_, i) => row(i + 1));
  const view = device.view(chatId);
  Object.assign(view, { messages: [row(99)], loaded: true, baseline: '99', mutation: '0', changesAfter: '99', changesSelection: 0 });
  const twentieth = gate();
  const around = gate();
  const fallback = gate();
  let pageRequests = 0;
  let latestRequests = 0;
  let completed = false;
  const sameSelection = ordering.startsWith('jumped in same selection');
  const duringFallback = ordering.includes('fallback');
  const finalFallback = ordering.endsWith('final fallback');
  const fallbackRequests = duringFallback ? finalFallback ? 3 : 1 : 0;
  device.get = async (path, args) => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/state')) return { lastSeq: '1200', mutationSeq: '0', visibilitySeq: '0', memberSeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    if (path.endsWith('/messages/changes')) {
      const seq = isOther ? '0' : String(1200 + (finalFallback ? latestRequests : 0));
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
      const messages = Array.from({ length: 50 }, (_, i) => row(start + i));
      if (end === 1049) Object.assign(messages.at(-1), { replyToMessageId: anchorRows[0].id, replySenderId: messages.at(-1).senderId, replyBody: anchorRows[0].body });
      return { messages, coverageThroughSequence: String(end), snapshotSequence: '1200', visibilitySeq: '0', nextSequence: String(end), hasMore: true };
    }
    if (!isOther) {
      latestRequests++;
      if (finalFallback && latestRequests < 3) await device.refreshChanges(chatId);
      else if (duringFallback) { fallback.entered(); await fallback.blocked; }
    }
    return { messages: isOther ? [] : Array.from({ length: 50 }, (_, i) => row(1151 + i)), coverageThroughSequence: isOther ? '0' : '1200', mutationSeq: isOther ? '0' : '1200', visibilitySeq: '0' };
  };
  let opening;
  if (ordering === 'opened after protection') {
    device.directory = [chat, other];
    const protect = device.protectWindow.bind(device);
    let triggered = false;
    device.protectWindow = (id, recovery) => protect(id, recovery).then(result => {
      if (id === chatId && recovery.remainingPages === 0 && !triggered) {
        triggered = true;
        opening = state.perform({ type: 'chatOpen', actor: 0, device: 0, chat: 0 }, performance.now());
      }
      return result;
    });
  }
  const recovery = sameSelection ? device.sync(chatId, { primary: true }) : device.catchUp(chatId, '1100');
  const result = recovery.then(() => { completed = true; return null; }, error => { completed = true; return error; });
  await twentieth.requested;
  view.detached = anchorRows[0];
  const jumping = ordering.startsWith('jumped');
  if (jumping) {
    if (!sameSelection) await device.disconnect();
    opening = state.perform({ type: 'jump', actor: 0, device: 0, chat: 0, reference: { quotedBack: 1 } }, performance.now());
  } else {
    await device.openChat(other, performance.now());
    if (ordering === 'opened after protection') twentieth.release();
    else opening = device.openChat(chat, performance.now());
  }
  await around.requested;
  const restoredOwner = jumping ? device.selection : view.changesSelection;
  if (ordering === 'left while loading' || jumping && !sameSelection) await device.openChat(other, performance.now());
  if (duringFallback) {
    twentieth.release();
    await fallback.requested;
  } else if (!jumping) twentieth.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(latestRequests, fallbackRequests);
  around.release();
  await opening;
  const installed = view.installedWindow;
  if (ordering === 'jumped after disconnect' || ordering === 'jumped in same selection during page') twentieth.release();
  if (duringFallback) fallback.release();
  const error = await result;
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(error?.code, 'catchUpGap');
  assert.equal(pageRequests, 20);
  assert.equal(latestRequests, fallbackRequests);
  assert.equal(view.messages.length, 50);
  assert.deepEqual(view.messages.map(message => message.id), anchorRows.map(message => message.id));
  assert.equal(view.messages[0].id, anchorRows[0].id);
  assert.equal(view.detached.id, anchorRows[0].id);
  assert.equal(view.changesSelection, jumping ? 0 : restoredOwner);
  assert.equal(view.installedWindow, installed);
  assert.equal(view.installedWindow?.selection, restoredOwner);
  if (sameSelection) assert.equal(device.selection, 0);
});
}

test('a late around response cannot replace the window of a newer open', { timeout: 10_000 }, async () => {
  const { state, device, chatId, otherId, chat, other, row } = fixture();
  const olderRows = Array.from({ length: 50 }, (_, i) => row(i + 1));
  const newerRows = Array.from({ length: 46 }, (_, i) => row(i + 55));
  const view = device.view(chatId);
  Object.assign(view, { messages: newerRows, loaded: true, baseline: '100', mutation: '2', changesAfter: '2', changesSelection: 0, installedWindow: { selection: 0 } });
  const older = gate();
  device.get = async path => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/messages/changes')) {
      const seq = isOther ? '0' : '101';
      return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: [] };
    }
    if (path.endsWith('/messages/around')) {
      older.entered();
      await older.blocked;
      return { messages: olderRows, mutationSeq: '2', anchorMessageId: olderRows[0].id };
    }
    assert.match(path, /\/messages$/);
    return { messages: isOther ? [] : newerRows, coverageThroughSequence: isOther ? '0' : '101', mutationSeq: isOther ? '0' : '101', visibilitySeq: '0' };
  };
  const jumping = device.around(chatId, olderRows[0]);
  await older.requested;
  await device.openChat(other, performance.now());
  await device.openChat(chat, performance.now());
  while (state.background.size) await Promise.all([...state.background]);
  const owner = view.installedWindow?.selection;
  older.release();
  await jumping;
  assert.equal(view.messages[0].sequence, '55');
  assert.equal(view.installedWindow?.selection, owner);
  assert.equal(view.changesSelection, owner);
  assert.equal(view.changesAfter, '101');
});

test('a quote jump refreshes protected IDs even within the same selection', { timeout: 10_000 }, async () => {
  const { state, device, chatId, otherId, chat, other, row } = fixture();
  const anchorRows = Array.from({ length: 50 }, (_, i) => row(i + 1));
  const latestRows = Array.from({ length: 11 }, (_, i) => row(i + 100));
  Object.assign(latestRows.at(-1), { replyToMessageId: anchorRows[0].id, replySenderId: anchorRows[0].senderId, replyBody: anchorRows[0].body });
  const view = device.view(chatId);
  Object.assign(view, { messages: [row(99)], loaded: true, baseline: '99', mutation: '0', changesAfter: '99', changesSelection: 0 });
  const first = gate();
  const second = gate();
  const cursors = [];
  let aroundRequests = 0;
  device.get = async (path, args) => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/messages/changes')) {
      const seq = isOther ? '0' : '110';
      return { lastSeq: seq, nextSeq: seq, resetRequired: false, changes: [] };
    }
    if (path.endsWith('/messages/around')) {
      aroundRequests++;
      return { messages: aroundRequests === 1 ? latestRows : anchorRows, anchorMessageId: aroundRequests === 1 ? latestRows[0].id : anchorRows[0].id, mutationSeq: '0' };
    }
    assert.match(path, /\/messages$/);
    if (args?.afterSeq) {
      cursors.push(args.afterSeq);
      const waiting = cursors.length === 1 ? first : second;
      waiting.entered();
      await waiting.blocked;
      return { messages: cursors.length === 1 ? latestRows.slice(0, 5) : latestRows.slice(5), coverageThroughSequence: cursors.length === 1 ? '104' : '110', snapshotSequence: '110', visibilitySeq: '0', nextSequence: cursors.length === 1 ? '104' : '110', hasMore: cursors.length === 1 };
    }
    assert.equal(isOther, true);
    return { messages: [], coverageThroughSequence: '0', mutationSeq: '0', visibilitySeq: '0' };
  };
  const recovering = device.catchUp(chatId, '110');
  await first.requested;
  view.detached = latestRows[0];
  await device.openChat(other, performance.now());
  await device.openChat(chat, performance.now());
  while (state.background.size) await Promise.all([...state.background]);
  first.release();
  await second.requested;
  const previousWindow = view.installedWindow;
  await state.perform({ type: 'jump', actor: 0, device: 0, chat: 0, reference: { quotedBack: 1 } }, performance.now());
  const jumpedWindow = view.installedWindow;
  await device.openChat(other, performance.now());
  second.release();
  await recovering;
  while (state.background.size) await Promise.all([...state.background]);
  assert.deepEqual(cursors, ['99', '104']);
  assert.equal(view.messages.length, 50);
  assert.equal(view.messages[0].id, anchorRows[0].id);
  assert.equal(view.installedWindow, jumpedWindow);
  assert.notEqual(jumpedWindow, previousWindow);
  assert.equal(jumpedWindow.selection, previousWindow.selection);
  assert.equal(view.baseline, '110');
});

test('an inactive recovery window rejects an older quote response', { timeout: 10_000 }, async () => {
  const { state, device, chatId, otherId, chat, other, row } = fixture();
  const anchorRows = Array.from({ length: 50 }, (_, i) => row(i + 1));
  const latestRows = Array.from({ length: 46 }, (_, i) => row(i + 55));
  Object.assign(latestRows.at(-1), { replyToMessageId: anchorRows[0].id, replySenderId: anchorRows[0].senderId, replyBody: anchorRows[0].body });
  const view = device.view(chatId);
  Object.assign(view, { messages: latestRows, loaded: true, baseline: '100', mutation: '2', changesAfter: '2', changesSelection: 0, installedWindow: { selection: 0 }, detached: anchorRows[0] });
  const around = gate();
  device.get = async path => {
    const isOther = path.includes(otherId);
    if (path.endsWith('/messages/changes')) return { lastSeq: '0', nextSeq: '0', resetRequired: false, changes: [] };
    if (path.endsWith('/messages/around')) {
      around.entered();
      await around.blocked;
      return { messages: anchorRows, anchorMessageId: anchorRows[0].id, mutationSeq: '2' };
    }
    assert.match(path, /\/messages$/);
    return { messages: isOther ? [] : latestRows, coverageThroughSequence: isOther ? '0' : '101', mutationSeq: isOther ? '0' : '101', visibilitySeq: '0' };
  };
  const jumping = state.perform({ type: 'jump', actor: 0, device: 0, chat: 0, reference: { quotedBack: 1 } }, performance.now());
  await around.requested;
  await device.openChat(other, performance.now());
  device.onFrame({ type: 'recovery_failed', chatId });
  while (state.background.size) await Promise.all([...state.background]);
  const recoveredWindow = view.installedWindow;
  const recoveredOwner = device.selection;
  assert.equal(view.changesSelection, 0);
  around.release();
  await jumping;
  assert.equal(view.messages[0].sequence, '55');
  assert.equal(view.installedWindow, recoveredWindow);
  assert.equal(recoveredWindow.selection, recoveredOwner);
  assert.equal(view.baseline, '101');
});
