import assert from 'node:assert/strict';
import test from 'node:test';
import { Run } from './run.mjs';
import { Fault, Measurements } from './transport.mjs';
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

test('verification counts a confirmation that arrives while resolving earlier rows', async () => {
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
  assert.equal(result.saved + result.missing, 2);
  assert.equal(result.saved, result.durableChecks);
  assert.equal(result.pending, result.saved === 2 ? 0 : 1);
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
