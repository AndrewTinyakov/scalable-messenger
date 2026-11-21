import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Fault, Measurements } from './transport.mjs';
import { ulid } from '../support/fixtures.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const counters = lastSeq => ({ lastSeq, mutationSeq: '0', memberSeq: '0', visibilitySeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' });
const page = seq => ({ messages: [], coverageThroughSequence: seq, mutationSeq: '0', visibilitySeq: '0', nextSequence: seq, hasMore: false });
const fixture = request => new Run({ chats: [], profile: { timing: { lagLimitMs: 1500 } } }, {
  devices: [[{ userId: ulid(), username: 'fixture', deviceId: 'fixture', cookie: 'old' }]], chats: [],
}, { request, options: {}, controller: new AbortController() }, new Measurements());

test('failed foreground waits for sibling HTTP work before reaching the cutoff', async () => {
  const pending = deferred();
  const state = fixture(async (_, path) => {
    if (path === '/auth/session') throw new Fault('http401');
    return {};
  });
  state.actions = [];
  const device = state.devices[0][0];
  device.catchUp = async () => { await pending.promise; };
  device.refreshDirectory = device.reconcile = device.refreshFeatures = async () => {};
  let completed = false;
  const action = state.perform({ type: 'foreground', actor: 0, device: 0, chat: null });
  const result = action.catch(error => { completed = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  pending.resolve();
  assert.equal((await result).code, 'http401');
  await state.finishTraffic();
  const message = { id: ulid() };
  state.recovered(device, message);
  state.readNotification(device, ulid(), { throughSequence: '9' });
  assert.equal(state.early.size, 0);
  assert.equal(state.readFrontiers.size, 0);
});

test('concurrent state recovery shares catch-up and preserves the highest requested sequence', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  Object.assign(device.view(id), { loaded: true, baseline: '1' });
  const blocked = deferred();
  const entered = deferred();
  const after = [];
  device.get = async (path, args) => {
    if (path.endsWith('/state')) return counters('2');
    after.push(args.afterSeq);
    entered.resolve();
    if (after.length === 1) await blocked.promise;
    return page(after.length === 1 ? '2' : '3');
  };
  const first = device.catchUp(id);
  await entered.promise;
  const stateCheck = device.sync(id);
  const higher = device.catchUp(id, '3');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(after, ['1']);
  blocked.resolve();
  await Promise.all([first, stateCheck, higher]);
  assert.deepEqual(after, ['1', '2']);
  assert.equal(device.view(id).baseline, '3');
});

test('state recovery can retry history after the initial open failed', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  const selected = { id, kind: 'DIRECT', members: [] };
  let pages = 0;
  device.get = async path => {
    if (path.endsWith('/state')) return counters('2');
    if (++pages === 1) throw new Fault('http503');
    return page('2');
  };
  device.subscribe = device.refreshChanges = () => {};
  await assert.rejects(device.openChat(selected, performance.now()), { code: 'http503' });
  await device.sync(id);
  assert.equal(pages, 2);
  assert.equal(device.view(id).loaded, true);
  assert.equal(device.view(id).baseline, '2');
  state.manifest.chats.push(id);
  state.roster.set(id, { kind: 'DIRECT', members: [0] });
  device.refreshChanges = () => {};
  await device.openChat(selected, performance.now());
  device.view(id).messages = [{ sequence: '2', senderId: ulid() }];
  let reads = 0;
  device.change = async () => { reads++; return { throughSequence: '2' }; };
  await state.perform({ type: 'read', actor: 0, device: 0, chat: 0 });
  assert.equal(reads, 1);
});

test('immediate selected state checks retain sequence floors', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  Object.assign(device.view(id), { loaded: true, baseline: '4', member: '3', changesAfter: '0', stateAt: performance.now() });
  const selected = { id, kind: 'DIRECT', members: [{ id: ulid() }] };
  device.selected = selected;
  device.socket = { opened: true, ws: { readyState: WebSocket.OPEN } };
  device.offerWatch = () => {};
  let floors;
  device.get = async (path, args) => { floors = args; return { ...counters('4'), memberSeq: '3' }; };
  await device.refreshFeatures(selected, true);
  assert.deepEqual(floors, { minSeq: '4', minMemberSeq: '3' });
});

test('final status detects a rejection after a saved result without changing traffic metrics', async () => {
  const id = ulid();
  const messageId = ulid();
  let record;
  const state = fixture(async (_, path) => path === '/sends/status' ? { results: [
    { requestId: record.requestId, result: { status: 'SAVED', chatId: id, messageId, sequence: '1' } },
    { requestId: record.requestId, result: { status: 'REJECTED', reason: 'NOT_A_MEMBER' } },
  ] } : { messages: [{ id: messageId, chatId: id, senderId: state.devices[0][0].credentials.userId, sequence: '1', messageVersion: '1', body: 'fixture' }] });
  state.actions = [{ type: 'send' }];
  const device = state.devices[0][0];
  device.requireSocket = () => ({ send() {} });
  const sending = state.send(device, performance.now(), id, { body: 'fixture' }, []);
  record = [...state.sends.values()][0];
  await state.finishTraffic();
  const frozen = JSON.stringify(state.metrics.raw());
  const verified = await state.verify();
  await sending;
  assert.equal(verified.saved, 1);
  assert.equal(verified.duplicates, 1);
  assert.equal(JSON.stringify(state.metrics.raw()), frozen);
});

test('a concurrent late 401 reuses the newly refreshed verifier session', async () => {
  const blocked = deferred();
  const ids = [ulid(), ulid()];
  let logins = 0;
  const records = [];
  const state = fixture(async (credentials, path) => {
    if (path === '/auth/logout') return null;
    if (path === '/auth/login') {
      if (++logins > 1) throw new Fault('http429');
      credentials.cookie = 'fresh';
      return { user: { id: credentials.userId, username: credentials.username }, deviceId: credentials.deviceId };
    }
    if (credentials.cookie !== 'fresh') {
      if (path.includes(ids[1])) await blocked.promise;
      throw new Fault('http401');
    }
    blocked.resolve();
    const row = records.find(record => path.includes(record.chatId));
    return { messages: [{ id: row.saved.id, chatId: row.chatId, senderId: credentials.userId, sequence: '1', messageVersion: '1', body: 'fixture' }] };
  });
  state.actions = ids.map(() => ({ type: 'send' }));
  const device = state.devices[0][0];
  for (const id of ids) {
    const record = { requestId: ulid(), chatId: id, device, saved: { id: ulid(), chatId: id, sequence: '1' }, body: 'fixture', received: new Map(), expected: [] };
    records.push(record);
    state.sends.set(record.requestId, record);
  }
  const result = await state.verify();
  assert.equal(logins, 1);
  assert.equal(result.durableChecks, 2);
  assert.equal(result.durableUnverified, 0);
  assert.equal(result.durableMismatches, 0);
});

test('deletion lookup must confirm the message target', async () => {
  let record;
  const operationId = ulid();
  const state = fixture(async () => ({ operationId, scope: 'EVERYONE', target: 'HISTORY' }));
  state.actions = [{ type: 'send' }];
  const device = state.devices[0][0];
  record = { requestId: ulid(), chatId: ulid(), device, saved: { id: ulid(), sequence: '1' }, body: 'fixture', received: new Map(), expected: [] };
  state.sends.set(record.requestId, record);
  state.mutations.set(record.saved.id, { kind: 'EVERYONE', device, status: 'uncertain', requestId: operationId });
  const result = await state.verify();
  assert.equal(result.durableUnverified, 1);
  assert.equal(state.verificationMetrics.failures['verification.mutation/invalidDeletionStatus'], 1);
});

test('read propagation dwell stops at the traffic cutoff before slow shutdown', async () => {
  const state = fixture(async () => ({}));
  state.actions = [];
  const device = state.devices[0][0];
  const id = ulid();
  const started = performance.now() - 3000;
  state.reads.set(id, [{ actor: 0, through: '1', started, confirmed: true, devices: [device], selections: new Map([[device, device.selection]]) }]);
  device.close = async () => {
    device.selectionEndedAt.set(device.selection, performance.now() + 3000);
    device.selection++;
  };
  await state.finishTraffic();
  const result = await state.verify();
  assert.equal(result.readPropagationExpected, 1);
  assert.equal(result.readPropagationMissing, 0);
  assert.equal(result.readPropagationInterrupted, 1);
});

test('catch-up accepts a new target in the completion microtask', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  const view = device.view(id);
  Object.assign(view, { loaded: true, baseline: '1' });
  const blocked = deferred();
  let pages = 0;
  device.loadCatchUp = () => ++pages === 1 ? blocked.promise.then(() => { view.baseline = '2'; }) : Promise.resolve().then(() => { view.baseline = '3'; });
  const first = device.catchUp(id, '2');
  await new Promise(resolve => setImmediate(resolve));
  let late;
  blocked.promise.then(() => queueMicrotask(() => { late = device.catchUp(id, '3'); }));
  blocked.resolve();
  await first;
  await late;
  assert.equal(pages, 2);
  assert.equal(view.baseline, '3');
});

test('final status credits receipts buffered before the cutoff', async () => {
  const chatId = ulid();
  const messageId = ulid();
  let record;
  const state = fixture(async (_, path) => path === '/sends/status' ? { results: [{ requestId: record.requestId,
    result: { status: 'SAVED', chatId, messageId, sequence: '1' } }] } : { messages: [{ id: messageId, chatId,
    senderId: state.devices[0][0].credentials.userId, sequence: '1', messageVersion: '1', body: 'fixture' }] });
  state.actions = [{ type: 'send' }];
  const device = state.devices[0][0];
  const peer = new device.constructor(state, { userId: device.credentials.userId }, 0);
  state.devices[0].push(peer);
  device.requireSocket = () => ({ send() {} });
  const sending = state.send(device, performance.now(), chatId, { body: 'fixture' }, [peer]);
  record = [...state.sends.values()][0];
  state.recovered(peer, { id: messageId });
  record.finish(null);
  await assert.rejects(sending, { code: 'sendPending' });
  await state.finishTraffic();
  const frozen = JSON.stringify(state.metrics.raw());
  const result = await state.verify();
  assert.equal(result.saved, 1);
  assert.equal(result.recipientsExpected, 1);
  assert.equal(result.recipientsMissing, 0);
  assert.equal(result.durableChecks, 1);
  assert.equal(JSON.stringify(state.metrics.raw()), frozen);
});

test('a late successful old session cannot replace a refreshed verifier credential', async () => {
  const oldSuccess = deferred();
  const slowUnauthorized = deferred();
  const ids = [ulid(), ulid(), ulid()];
  let logins = 0;
  const records = [];
  const state = fixture(async (credentials, path) => {
    if (path === '/auth/logout') return null;
    if (path === '/auth/login') {
      if (++logins > 1) throw new Fault('http429');
      credentials.cookie = 'fresh';
      return { user: { id: credentials.userId, username: credentials.username }, deviceId: credentials.deviceId };
    }
    const row = records.find(record => path.includes(record.chatId));
    if (credentials.cookie === 'old') {
      if (row.chatId === ids[0]) await oldSuccess.promise;
      else {
        if (row.chatId === ids[2]) await slowUnauthorized.promise;
        throw new Fault('http401');
      }
    } else if (row.chatId === ids[1]) {
      oldSuccess.resolve();
      setImmediate(slowUnauthorized.resolve);
    }
    return { messages: [{ id: row.saved.id, chatId: row.chatId, senderId: credentials.userId, sequence: '1', messageVersion: '1', body: 'fixture' }] };
  });
  state.actions = ids.map(() => ({ type: 'send' }));
  const device = state.devices[0][0];
  for (const id of ids) {
    const record = { requestId: ulid(), chatId: id, device, saved: { id: ulid(), chatId: id, sequence: '1' }, body: 'fixture', received: new Map(), expected: [] };
    records.push(record);
    state.sends.set(record.requestId, record);
  }
  const result = await state.verify();
  assert.equal(logins, 1);
  assert.equal(result.durableChecks, 3);
  assert.equal(result.durableUnverified, 0);
  assert.equal(result.durableMismatches, 0);
});

test('same-chat open retries a failed initial page before state recovery', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  const selected = { id, kind: 'DIRECT', members: [] };
  device.subscribe = device.refreshChanges = () => {};
  let pages = 0;
  device.get = async () => {
    if (++pages === 1) throw new Fault('invalidJson');
    return page('0');
  };
  await assert.rejects(device.openChat(selected, performance.now()), { code: 'invalidJson' });
  await device.openChat(selected, performance.now());
  assert.equal(pages, 2);
  assert.equal(device.view(id).loaded, true);
  assert.equal(device.view(id).ready, null);
});

test('a settled history error is retired while unread cleanup still drains', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  const selected = { id, kind: 'DIRECT', members: [], markedUnread: true };
  state.manifest.chats.push(id);
  state.roster.set(id, { kind: 'DIRECT', members: [0] });
  const deletion = deferred();
  let pages = 0;
  let reads = 0;
  device.subscribe = device.refreshChanges = () => {};
  device.get = async path => {
    if (path.endsWith('/state')) return counters('1');
    if (++pages === 1) throw new Fault('invalidJson');
    return page('1');
  };
  device.change = async (path, method) => {
    if (method === 'DELETE') return deletion.promise;
    reads++;
    return { throughSequence: '1' };
  };
  let finished = false;
  const opening = device.openChat(selected, performance.now()).catch(error => { finished = true; return error; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(device.view(id).ready, null);
  await device.sync(id);
  await device.openChat(selected, performance.now());
  device.view(id).messages = [{ sequence: '1', senderId: ulid() }];
  await state.perform({ type: 'read', actor: 0, device: 0, chat: 0 });
  assert.equal(reads, 1);
  assert.equal(finished, false);
  deletion.resolve();
  assert.equal((await opening).code, 'invalidJson');
});

test('selected history repair resumes mutation changes from its snapshot cursor', async () => {
  const state = fixture(async () => {});
  const device = state.devices[0][0];
  const id = ulid();
  const original = { id: ulid(), chatId: id, senderId: ulid(), sequence: '1', messageVersion: '1', body: 'original' };
  let edited = false;
  let pages = 0;
  let changes = 0;
  device.subscribe = () => {};
  device.get = async (path, args) => {
    if (path.endsWith('/state')) return { ...counters(edited ? '2' : '1'), mutationSeq: edited ? '2' : '1' };
    if (path.endsWith('/messages/changes')) {
      changes++;
      return edited ? { lastSeq: '2', nextSeq: '2', resetRequired: false, changes: [{ kind: 'UPSERT', seq: '2', sequence: '1', messageId: original.id,
        message: { ...original, body: 'edited', messageVersion: '2' } }] } : { lastSeq: '1', nextSeq: '1', resetRequired: false, changes: [] };
    }
    if (++pages === 1) throw new Fault('invalidJson');
    if (args.afterSeq) return page('2');
    return { ...page('1'), mutationSeq: '1', messages: [original] };
  };
  const selected = { id, kind: 'DIRECT', members: [] };
  await assert.rejects(device.openChat(selected, performance.now()), { code: 'invalidJson' });
  await device.sync(id);
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(device.view(id).changesAfter, '1');
  await device.openChat(selected, performance.now());
  edited = true;
  device.onFrame({ type: 'message_changed', chatId: id });
  while (state.background.size) await Promise.all([...state.background]);
  assert.ok(changes >= 2);
  assert.equal(device.view(id).changesAfter, '2');
  assert.equal(device.view(id).messages[0].body, 'edited');
  assert.equal(device.view(id).messages[0].messageVersion, '2');
  assert.deepEqual(Object.keys(state.metrics.failures), []);
});
