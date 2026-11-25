import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Fault, Http, Measurements } from './transport.mjs';
import { ulid } from '../support/fixtures.mjs';

function fixture(request) {
  const chat = ulid();
  const user = ulid();
  const state = new Run({ chats: [{ id: 0, kind: 'DIRECT', members: [0, 1] }] }, {
    devices: [[{ userId: user }], [{ userId: ulid() }]], chats: [chat],
  }, { options: {}, controller: new AbortController(), request }, new Measurements());
  state.actions = [];
  return { state, chat, device: state.devices[0][0], user };
}

function track(state, device, chat, sequence = null) {
  const record = { requestId: ulid(), device, chatId: chat, body: 'fixture body', expected: [], received: new Map(),
    sent: performance.now(), finish() {} };
  state.sends.set(record.requestId, record);
  state.actions.push({ type: 'send' });
  if (sequence) state.saved(record, { chatId: chat, messageId: ulid(), sequence }, false);
  return record;
}

test('verification retains the cutoff before the first durable resolve', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { state, chat, device } = fixture(async (_, path, method, body) => {
    if (path === '/auth/session') return { userId: device.credentials.userId };
    if (path === '/sends/status') return { results: [] };
    entered();
    await pending;
    return { messages: body.messageIds.map(id => ({ id, chatId: chat, senderId: device.credentials.userId,
      sequence: id === first.saved.id ? '1' : '2', messageVersion: '1', body: 'fixture body' })) };
  });
  const first = track(state, device, chat, '1');
  const second = track(state, device, chat);
  const verifying = state.verify();
  await started;
  state.saved(second, { chatId: chat, messageId: ulid(), sequence: '2' }, true);
  release();
  const result = await verifying;
  assert.equal(result.saved, 1);
  assert.equal(result.missing, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.durableChecks, 1);
});

test('a duplicate account read does not create a propagation expectation', async () => {
  const { state, chat, device } = fixture(async () => ({ throughSequence: '8', readAt: '2026-01-01T00:00:00Z' }));
  const peer = state.devices[1][0];
  peer.selected = { id: chat };
  state.expected = () => [device, peer];
  device.selected = { id: chat };
  device.view(chat).messages = [{ sequence: '8', senderId: peer.credentials.userId }];
  state.readNotification(device, chat, { throughSequence: '8', maxOtherReadSequence: '0' });
  await state.read(device, chat);
  assert.equal((state.reads.get(chat) ?? []).length, 0);
});

test('measurement teardown cannot turn a missing live delivery into an interruption', async () => {
  const { state, chat, device, user } = fixture(async () => ({ messages: [{ id: record.saved.id, chatId: chat,
    senderId: user, sequence: '1', messageVersion: '1', body: 'fixture body' }] }));
  const peer = state.devices[1][0];
  const record = track(state, device, chat, '1');
  record.expected = [device, peer];
  record.lifecycles = new Map([[peer, peer.connection]]);
  await state.finishTraffic();
  const verified = await state.verify();
  assert.equal(verified.recipientsMissing, 1);
  assert.equal(verified.recipientsInterrupted, 0);
});

test('a failed read is not counted as a confirmed missing propagation', async () => {
  const { state, chat, device } = fixture(async () => { throw new Error('request failed'); });
  const peer = state.devices[1][0];
  peer.selected = { id: chat };
  state.expected = () => [device, peer];
  device.selected = { id: chat };
  device.view(chat).messages = [{ sequence: '8', senderId: peer.credentials.userId }];
  await assert.rejects(state.read(device, chat));
  assert.equal((state.reads.get(chat) ?? []).length, 0);
});

test('an uncertain edit accepts either known outcome but rejects unrelated stored text', async () => {
  for (const [body, version, mismatches] of [['fixture body', '1', 0], ['edited body', '2', 0], ['incorrect body', '2', 2]]) {
    const { state, chat, device, user } = fixture(async () => ({ messages: [{ id: record.saved.id, chatId: chat,
      senderId: user, sequence: '1', messageVersion: version, body }] }));
    const record = track(state, device, chat, '1');
    state.mutations.set(record.saved.id, { kind: 'edit', device, status: 'uncertain', body: 'edited body', version: '2', before: { version: '1' } });
    const verified = await state.verify();
    assert.equal(verified.durableMismatches, mismatches);
    assert.equal(verified.durableChecks, 2);
    if (mismatches) {
      assert.equal(state.diagnostics.length, 2);
      assert.doesNotMatch(JSON.stringify(state.diagnostics), /incorrect body|edited body|fixture body/);
    }
  }
});

test('a deletion with a lost response is resolved by its operation ID for both viewers', async () => {
  const operationId = ulid();
  const { state, chat, device, user } = fixture(async (credentials, path) => {
    if (path.endsWith('/deletions/' + operationId)) return { operationId, scope: 'SELF', target: 'MESSAGES' };
    return { messages: credentials.userId === user ? [] : [{ id: record.saved.id, chatId: chat,
      senderId: user, sequence: '1', messageVersion: '1', body: 'fixture body' }] };
  });
  const record = track(state, device, chat, '1');
  state.mutations.set(record.saved.id, { kind: 'SELF', device, requestId: operationId, status: 'uncertain' });
  const verified = await state.verify();
  assert.equal(verified.durableMismatches, 0);
  assert.equal(verified.durableChecks, 2);
});

test('verification refreshes a revoked session without changing its viewer identity', async () => {
  let logins = 0;
  const { state, chat, device, user } = fixture(async (credentials, path, method, input) => {
    if (path === '/auth/login') {
      logins++;
      credentials.cookie = 'fresh';
      return { user: { id: user, username: credentials.username }, deviceId: input.deviceId };
    }
    if (path === '/auth/logout') return null;
    if (credentials.cookie !== 'fresh') throw new Fault('http401');
    assert.equal(credentials.userId, user);
    return { messages: [{ id: record.saved.id, chatId: chat, senderId: user, sequence: '1', messageVersion: '1', body: 'fixture body' }] };
  });
  Object.assign(device.credentials, { cookie: 'revoked', username: 'fixture', password: 'private-fixture' });
  const record = track(state, device, chat, '1');
  const verified = await state.verify();
  assert.equal(logins, 1);
  assert.equal(verified.durableChecks, 1);
  assert.equal(verified.durableUnverified, 0);
  assert.equal(device.credentials.cookie, 'revoked');
});

test('forwarding selects an immutable fixture source rather than a concurrently edited send', async () => {
  const { state, chat, device, user } = fixture(async () => {});
  const source = ulid();
  const destination = { id: chat, kind: 'DIRECT', members: [] };
  state.manifest.chats.push(source);
  state.plan.chats.push({ history: Array.from({ length: 100 }) });
  device.selected = destination;
  device.directory = [destination, { id: source, kind: 'DIRECT', members: [] }];
  device.openChat = async selected => { device.selected = selected; };
  device.get = async (path, args) => {
    assert.equal(path, '/chats/' + source + '/messages');
    assert.equal(args.beforeSeq, '101');
    return { messages: [{ id: ulid(), chatId: source, senderId: user, sequence: '100', messageVersion: '1', body: 'stable seeded content' }] };
  };
  state.expected = () => [];
  state.send = async (_, due, id, frame) => {
    assert.equal(id, chat);
    assert.equal(frame.body, 'stable seeded content');
    assert.equal(frame.forwardFromChatId, source);
    return { id: ulid(), chatId: chat, sequence: '101' };
  };
  await state.perform({ type: 'forward', actor: 0, device: 0, chat: 0, source: 1, reference: { back: 1 } }, performance.now());
  assert.equal(device.selected, destination);
});

test('scheduled login cannot replace a session until logout cleanup finishes', async () => {
  const { state, device, user } = fixture(async (credentials, path, method, input) => {
    if (path === '/auth/login') {
      credentials.cookie = 'new';
      return { user: { id: user, username: credentials.username }, deviceId: input.deviceId };
    }
    return null;
  });
  Object.assign(device.credentials, { username: 'fixture', deviceId: 'fixture', cookie: 'old' });
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  device.close = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  device.startup = async () => {};
  const logout = state.perform({ type: 'logout', actor: 0, device: 0, chat: null });
  await started;
  const login = state.perform({ type: 'login', actor: 0, device: 0, chat: null });
  release();
  await Promise.all([logout, login]);
  assert.equal(device.credentials.cookie, 'new');
});

test('a returned frontier above the requested read cannot claim an advance', async () => {
  const { state, chat, device } = fixture(async () => ({ throughSequence: '9', readAt: '2026-01-01T00:00:00Z' }));
  device.selected = { id: chat };
  device.view(chat).messages = [{ sequence: '8', senderId: state.devices[1][0].credentials.userId }];
  await state.read(device, chat);
  assert.equal(state.reads.get(chat).length, 0);
  assert.equal(state.readFrontiers.get('0/' + chat), '9');
});

test('overlapping same-account read writes retain the actual advancing operation', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { state, chat, device } = fixture(async () => {
    calls++;
    entered();
    await blocked;
    return { throughSequence: '9', readAt: '2026-01-01T00:00:00Z' };
  });
  const twin = new device.constructor(state, { userId: device.credentials.userId }, 0);
  state.devices[0].push(twin);
  for (const peer of [device, twin]) {
    peer.selected = { id: chat };
    peer.view(chat).messages = [{ sequence: '9', senderId: state.devices[1][0].credentials.userId }];
  }
  state.expected = () => [device, twin];
  const first = state.read(device, chat);
  await started;
  const second = state.read(twin, chat);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(state.reads.get(chat).length, 1);
  assert.equal(state.reads.get(chat)[0].devices.includes(twin), true);
});

test('an unrelated group member cannot satisfy a reader propagation check', async () => {
  const { state, chat, device } = fixture(async () => ({ throughSequence: '8', readAt: '2026-01-01T00:00:00Z' }));
  state.roster.get(chat).kind = 'GROUP';
  const peer = state.devices[1][0];
  device.selected = peer.selected = { id: chat };
  device.view(chat).messages = [{ sequence: '8', senderId: peer.credentials.userId }];
  state.expected = () => [device, peer];
  await state.read(device, chat);
  state.readNotification(peer, chat, { throughSequence: '0', maxOtherReadSequence: '8' });
  const record = state.reads.get(chat)[0];
  assert.equal(record.devices.length, 0);
  assert.equal(record.observed, undefined);
});

test('app close fences a scheduled login whose authentication is still pending', async () => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const { state, device, user } = fixture(async (credentials, path) => {
    assert.equal(path, '/auth/login');
    entered();
    await blocked;
    return { user: { id: user, username: credentials.username }, deviceId: credentials.deviceId };
  });
  Object.assign(device.credentials, { username: 'fixture', deviceId: 'fixture' });
  let startups = 0;
  device.startup = async () => { startups++; };
  const login = state.perform({ type: 'login', actor: 0, device: 0, chat: null });
  await started;
  await state.perform({ type: 'appClose', actor: 0, device: 0, chat: null });
  release();
  await assert.rejects(login, { code: 'socketClosed' });
  assert.equal(startups, 0);
  assert.equal(device.phase, 'closed');
  assert.equal(device.socket, null);
});

test('status reconciliation cannot expose a server-supplied rejection reason', async () => {
  const marker = 'private-response-text';
  const { state, chat, device } = fixture(async () => ({ results: [{ requestId: record.requestId,
    result: { status: 'REJECTED', reason: marker } }] }));
  const record = track(state, device, chat);
  record.finish = (_, reason) => { record.rejected = reason; };
  await state.verify();
  assert.equal(record.rejected, 'rejectedByStatus');
  assert.doesNotMatch(JSON.stringify(state.diagnostics), /private-response-text/);
});

test('final reconciliation and failures leave the frozen workload metrics unchanged', async () => {
  const messageId = ulid();
  const { state, chat, device } = fixture(async (_, path) => {
    if (path === '/sends/status') return { results: [{ requestId: record.requestId,
      result: { status: 'SAVED', messageId, chatId: chat, sequence: '1' } }] };
    throw new Fault('http503');
  });
  const record = track(state, device, chat);
  state.metrics.startStages([{ atMs: 0, users: 1 }]);
  await state.finishTraffic();
  const before = JSON.stringify(state.metrics.raw());
  const result = await state.verify();
  assert.equal(result.saved, 1);
  assert.equal(result.durableUnverified, 1);
  assert.equal(JSON.stringify(state.metrics.raw()), before);
  assert.equal(state.verificationMetrics.report().latencies['send.statusConfirmation'].count, 1);
  assert.equal(state.verificationMetrics.failures['verification/http503'], 1);
});

test('verification tries a healthy sibling session before a fresh login', async () => {
  let logins = 0;
  const { state, chat, device, user } = fixture(async (credentials, path) => {
    if (path === '/auth/login') { logins++; throw new Fault('http429'); }
    if (credentials.cookie !== 'healthy') throw new Fault('http401');
    return { messages: [{ id: record.saved.id, chatId: chat, senderId: user,
      sequence: '1', messageVersion: '1', body: 'fixture body' }] };
  });
  device.credentials.cookie = 'revoked';
  state.devices[0].push(new device.constructor(state, { userId: user, cookie: 'healthy' }, 0));
  const record = track(state, device, chat, '1');
  const result = await state.verify();
  assert.equal(result.durableChecks, 1);
  assert.equal(result.durableUnverified, 0);
  assert.equal(logins, 0);
});

test('a failed verifier refresh does not poison later batches', async () => {
  let logins = 0;
  const { state, chat, device, user } = fixture(async (credentials, path, method, body) => {
    if (path === '/auth/login') {
      if (++logins === 1) throw new Fault('http429');
      credentials.cookie = 'fresh';
      return { user: { id: user, username: credentials.username }, deviceId: credentials.deviceId };
    }
    if (path === '/auth/logout') return null;
    if (credentials.cookie !== 'fresh') throw new Fault('http401');
    return { messages: [{ id: body.messageIds[0], chatId: chat, senderId: user,
      sequence: '2', messageVersion: '1', body: 'fixture body' }] };
  });
  Object.assign(device.credentials, { cookie: 'revoked', username: 'fixture' });
  const record = track(state, device, chat, '1');
  state.mutations.set(record.saved.id, { kind: 'SELF', device, status: 'uncertain', requestId: ulid() });
  const second = track(state, device, chat, '2');
  const result = await state.verify();
  assert.equal(logins, 2);
  assert.equal(result.durableUnverified, 1);
  assert.equal(result.durableChecks, 1);
  assert.equal(result.durableMismatches, 0);
  assert.equal(second.saved.sequence, '2');
});

test('a committed deletion stays uncertain when its retry returns unauthorized', async ({ mock }) => {
  const { state, chat, device, user } = fixture(async (_, path) => {
    const mutation = state.mutations.get(record.saved.id);
    if (path.endsWith('/deletions/' + mutation.requestId)) return { operationId: mutation.requestId, scope: 'EVERYONE', target: 'MESSAGES' };
    return { messages: [] };
  });
  const record = track(state, device, chat, '1');
  state.reference = async () => ({ id: record.saved.id, body: record.body, messageVersion: '1' });
  const http = new Http({ api: 'http://localhost/api', origin: 'http://localhost', authRate: 1, ticketRate: 1 }, new Measurements());
  let attempts = 0;
  mock.method(globalThis, 'fetch', async () => {
    if (++attempts === 1) throw new TypeError('response lost after commit');
    return new Response(null, { status: 401 });
  });
  device.change = (...args) => http.request(device.credentials, ...args);
  try {
    await assert.rejects(state.editOrDelete(device, { type: 'deleteEveryone' }, chat, '/chats/' + chat), { code: 'http401' });
    assert.equal(attempts, 2);
    assert.equal(state.mutations.get(record.saved.id).status, 'uncertain');
    const result = await state.verify();
    assert.equal(result.mutationChecks, 2);
    assert.equal(result.durableMismatches, 0);
    assert.equal(result.durableUnverified, 0);
  } finally {
    http.controller.abort();
  }
});

test('foreground and reconnect force recent selected-chat state recovery', async () => {
  const { state, chat, device } = fixture(async () => null);
  const selected = { id: chat, kind: 'DIRECT', members: [{ id: 'peer' }] };
  device.selected = selected;
  device.view(chat).stateAt = performance.now();
  device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send() {} };
  device.offerWatch = () => {};
  device.connect = async () => {};
  device.catchUp = device.refreshDirectory = device.reconcile = async () => {};
  device.backgroundTask = () => {};
  const checks = [];
  device.sync = async (id, options) => { checks.push([id, options]); };
  for (const type of ['foreground', 'reconnect']) await state.perform({ type, actor: 0, device: 0, chat: 0 }, performance.now());
  assert.deepEqual(checks, [[chat, undefined], [chat, undefined]]);
});
