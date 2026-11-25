import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Device } from './device.mjs';
import { mergeReports } from './merge.mjs';
import { buildPlan } from './plan.mjs';
import { resolveReference, schedule } from './schedule.mjs';
import { Http, Measurements } from './transport.mjs';

const profile = name => JSON.parse(readFileSync(new URL('./profiles/' + name + '.json', import.meta.url)));

test('CLI writes identical plan bytes for identical inputs', () => {
  const input = './profiles/smoke.json';
  const args = ['main.mjs', 'plan', '--profile', input, '--seed', '1118'];
  const options = { cwd: import.meta.dirname };
  assert.deepEqual(execFileSync(process.execPath, args, options), execFileSync(process.execPath, args, options));
  assert.notDeepEqual(buildPlan(profile('smoke'), 1118), buildPlan(profile('smoke'), 1119));
});

test('large profile realizes the population, topology and action mix', () => {
  const input = profile('users-1000');
  const plan = buildPlan(input, 1118);
  for (const persona of input.personas) {
    const count = plan.population.filter(user => user.persona === persona.name).length;
    assert.ok(Math.abs(count / input.users - persona.share) <= .01, persona.name);
  }
  for (const [index, share] of input.devicesPerUser.entries()) {
    const count = plan.population.filter(user => user.devices === index + 1).length;
    assert.ok(Math.abs(count / input.users - share) <= .01);
  }
  const ofType = type => plan.actions.filter(action => action.type === type);
  const sends = ofType('send');
  const opens = ofType('chatOpen');
  for (const type of ['appOpen', 'appClose', 'scroll', 'jump', 'read', 'send', 'edit', 'deleteSelf', 'deleteEveryone',
    'forward', 'pinMessage', 'mute', 'pinChat', 'unread', 'readers', 'lookup', 'direct', 'group', 'sessions',
    'logout', 'login', 'background', 'foreground', 'disconnect', 'reconnect']) assert.ok(ofType(type).length, type);
  assert.ok(Math.abs(sends.filter(action => action.reference).length / sends.length - input.rates.reply) < .025);
  for (const type of ['scroll', 'jump', 'mute', 'pinChat', 'unread']) {
    const proportion = ofType(type).length / opens.length;
    assert.ok(Math.abs(proportion - input.rates[type]) < .025, type);
  }
  const active = sends.filter(action => action.persona === 'active').length;
  const lurkers = sends.filter(action => action.persona === 'lurker').length;
  assert.ok(active > lurkers * 5);
  assert.ok(plan.chats.some(chat => chat.members.length >= 200));
  assert.ok(plan.chats.filter(chat => chat.kind === 'GROUP' && chat.members.length <= 10).length >= 200);
  for (const chat of plan.chats) {
    const quoted = chat.history.at(-1).replyTo;
    assert.ok(Number.isInteger(quoted) && quoted >= 0 && quoted < chat.history.length - 1);
  }
  const lastEnd = new Map();
  for (const session of plan.sessions) {
    const key = session.actor + '/' + session.device;
    assert.ok(session.start > (lastEnd.get(key) ?? -1), 'returns never overlap on one device');
    lastEnd.set(key, session.end);
  }
  const byId = new Map(plan.actions.map(action => [action.id, action]));
  let crossUserReplies = 0;
  for (const action of plan.actions) {
    const session = plan.sessions[action.session];
    assert.ok(action.at >= session.start && action.at <= session.end);
    if (action.chat !== null) assert.ok(plan.chats[action.chat].members.includes(action.actor));
    if (action.reference?.send !== undefined) {
      const target = byId.get(action.reference.send);
      assert.equal(target.chat, action.chat);
      assert.equal(target.type, 'send');
      assert.ok(target.at < action.at);
      if (action.type === 'send') {
        assert.notEqual(target.actor, action.actor);
        assert.ok(action.at - target.at >= input.timing.replyMinMs - 1);
        assert.ok(action.at - target.at <= input.timing.replyMaxMs + 1);
        crossUserReplies++;
      }
    }
  }
  assert.ok(crossUserReplies > 100);

  const rare = new Set(['sessions', 'lookup', 'direct', 'group', 'logout', 'login']);
  const rareTimes = new Set();
  for (const action of plan.actions.filter(action => rare.has(action.type))) {
    const key = action.actor + '/' + action.device + '@' + action.at;
    assert.ok(!rareTimes.has(key), 'one device does one rare action at a time');
    rareTimes.add(key);
  }
});

test('invalid profiles name the offending fields', () => {
  const input = profile('smoke');
  assert.throws(() => buildPlan({ ...input, rates: { ...input.rates, scroll: 2 } }, 1), /Invalid profile: rates$/);
  assert.throws(() => buildPlan({ ...input, users: 3 }, 1), /Invalid profile: users$/);
});

test('scheduler offers later actions while an earlier action remains unanswered and records lateness', async () => {
  let clock = 0;
  let unblock;
  const first = new Promise(resolve => { unblock = resolve; });
  const dispatched = [];
  const lags = [];
  const result = await schedule([{ at: 10 }, { at: 20 }, { at: 30 }], async action => {
    dispatched.push(action.at);
    if (action.at === 10) await first;
    if (action.at === 30) unblock();
  }, {
    now: () => clock,
    sleep: async ms => { clock += ms + 3; },
    lag: ms => lags.push(ms),
  });
  assert.deepEqual(dispatched, [10, 20, 30]);
  assert.deepEqual(lags, [3, 3, 3]);
  assert.equal(result.offered, 3);
  assert.ok(result.peak >= 2);
  assert.equal(result.pending, 0);
});

test('scheduler reports actions offered above its capacity', async () => {
  const failures = [];
  const result = await schedule([{ at: 0 }, { at: 0 }], () => Promise.resolve(), {
    now: () => 0, limit: 1, failed: (_, error) => failures.push(error.code),
  });
  assert.equal(result.offered, 2);
  assert.deepEqual(failures, ['scheduleCapacity']);
});

test('logical references resolve earlier send results and recent messages', async () => {
  const sent = { id: 'sent', sequence: '117' };
  const recent = [{ id: 'history-10' }, { id: 'history-11' }, { id: 'history-12' }];
  const lookup = key => key === 82 ? Promise.resolve(sent) : undefined;
  assert.equal(await resolveReference({ send: 82 }, lookup, recent), sent);
  assert.equal(await resolveReference({ back: 2 }, lookup, recent), recent[1]);
  assert.equal(await resolveReference({ send: 83 }, lookup, recent), null);
  assert.equal(await resolveReference({ back: 4 }, lookup, recent), null);
});

test('fixed histogram covers zero and long tails without retaining observations', () => {
  const metrics = new Measurements();
  for (let i = 0; i < 98; i++) metrics.observe('action.test', 0);
  metrics.observe('action.test', 16);
  metrics.observe('action.test', 1200000);
  const result = metrics.report().latencies['action.test'];
  assert.equal(metrics.latencies.get('action.test').buckets.length, 64);
  assert.equal(result.count, 100);
  assert.ok(result.p95UpperMs <= .001);
  assert.ok(result.p99UpperMs >= 16 && result.p99UpperMs < 33);
  assert.equal(result.maxMs, 1200000);
});

test('HTTP failures report status without the response body, auth headers or submitted text', async ({ mock }) => {
  const metrics = new Measurements();
  const http = new Http({ api: 'http://localhost:8081/api', origin: 'http://localhost:8080', authRate: 1, ticketRate: 4 }, metrics);
  const cookie = 'messenger_session=secret-cookie-fixture';
  const body = 'secret-submitted-text';
  const fetch = mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.cookie, cookie);
    assert.equal(JSON.parse(options.body).body, body);
    return new Response('secret-server-error', { status: 403 });
  });
  await assert.rejects(http.request({ cookie }, '/chats/test/messages/test', 'PATCH', { body }), error => {
    metrics.failure('action.edit', error);
    return error.code === 'http403';
  });
  assert.equal(fetch.mock.callCount(), 1);
  const report = JSON.stringify(metrics.report());
  assert.match(report, /action\.edit\/http403/);
  assert.match(report, /"403":1/);
  assert.doesNotMatch(report, /secret-/);
});

test('ramp profile adds users in stages at a steady per-user rate', () => {
  const input = { ...profile('users-200'), name: 'ramp', durationMs: 900000,
    ramp: { periodMs: 600000, stages: [{ atMs: 0, users: 50 }, { atMs: 300000, users: 100 }, { atMs: 600000, users: 200 }] } };
  input.users = 200;
  const plan = buildPlan(input, 1118);
  const joined = id => input.ramp.stages.find(stage => id < stage.users).atMs;
  assert.ok(plan.sessions.every(session => session.start >= joined(session.actor) && session.end <= input.durationMs));
  // Sessions per user per period match the profile, whatever the join time.
  const rate = users => {
    const ids = new Set(plan.population.filter(user => users(user.id)).map(user => user.id));
    const window = input.durationMs - joined([...ids][0]);
    return plan.sessions.filter(session => ids.has(session.actor)).length / ids.size / window;
  };
  const early = rate(id => id < 50);
  const late = rate(id => id >= 100);
  assert.ok(Math.abs(late / early - 1) < .25, `${early} vs ${late}`);
  assert.throws(() => buildPlan({ ...input, ramp: { ...input.ramp, stages: input.ramp.stages.slice(1) } }, 1118), /ramp/);
  assert.equal(JSON.stringify(buildPlan(profile('users-200'), 1118)), JSON.stringify(buildPlan(profile('users-200'), 1118)));
});

test('stage metrics follow the clock', () => {
  const metrics = new Measurements();
  metrics.startStages([{ atMs: 0, users: 10 }, { atMs: 50, users: 20 }], performance.now());
  metrics.observe('send.ownAck', 5);
  metrics.status(500);
  metrics.stageStarted -= 100;
  metrics.observe('send.ownAck', 7);
  const [first, second] = metrics.report().stages;
  assert.equal(first.latencies['send.ownAck'].count, 1);
  assert.equal(first.httpStatuses[500], 1);
  assert.equal(second.latencies['send.ownAck'].maxMs, 7);
  assert.equal(metrics.report().latencies['send.ownAck'].count, 2);
});

test('shard reports merge into the same totals as one combined run', () => {
  const whole = new Measurements();
  const parts = [new Measurements(), new Measurements()];
  for (const [index, ms] of [3, 40, 7, 900, 12, 55].entries()) {
    whole.observe('send.recipientLive', ms);
    whole.count('send.saved');
    parts[index % 2].observe('send.recipientLive', ms);
    parts[index % 2].count('send.saved');
  }
  const report = (part, index) => ({
    format: 'messenger-realistic-load-report-v2', profile: 'p', seed: 1, shard: { index, count: 2 },
    fingerprint: 'plan', startAt: 1, manifestFingerprint: 'stack',
    plannedActions: 3, schedule: { offered: 3, peak: index + 1, pending: 0, lagLimitMs: 1500 },
    correctness: { saved: 3, missing: index }, ticketAdmission: { admitted: 7 + 4 * index, rejected: index, maximumRequestsPerSecond: 75, intervalMs: 1000 / 75, peakPending: index + 2 }, failedActionSamples: [], passed: index === 0,
    rawMetrics: part.raw(), verificationRawMetrics: new Measurements().raw(),
  });
  const merged = mergeReports(parts.map(report));
  assert.deepEqual(merged.metrics.latencies, whole.report().latencies);
  assert.equal(merged.metrics.counts['send.saved'], 6);
  assert.deepEqual(merged.correctness, { saved: 6, missing: 1 });
  assert.deepEqual(merged.ticketAdmission, { admitted: 18, rejected: 1, maximumRequestsPerSecond: 150, intervalMs: 1000 / 150, peakPending: 3 });
  assert.equal(merged.schedule.peak, 2);
  assert.equal(merged.schedule.lagLimitMs, 1500);
  assert.equal(merged.passed, false);
  assert.throws(() => mergeReports([report(parts[0], 0), report(parts[1], 0)]));
  assert.throws(() => mergeReports([report(parts[0], 0), { ...report(parts[1], 1), fingerprint: 'other plan' }]));
  assert.throws(() => mergeReports([report(parts[0], 0), { ...report(parts[1], 1), startAt: 2 }]));
  assert.throws(() => mergeReports([report(parts[0], 0), { ...report(parts[1], 1), manifestFingerprint: 'other stack' }]));
});

test('a read hint during a running check owes exactly one more primary check', async () => {
  const state = { background: new Set(), capacity: 1, metrics: { failure: () => assert.fail('unexpected failure') } };
  const device = new Device(state, { userId: 'u' }, 0);
  device.selected = { id: 'chat' };
  const calls = [];
  let release;
  device.sync = (id, options) => {
    calls.push(options);
    return calls.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  };
  const running = device.recheckReads('chat');
  await new Promise(resolve => setImmediate(resolve));
  device.recheckReads('chat');
  device.recheckReads('chat');
  release();
  await running;
  assert.deepEqual(calls, [{ primary: true }, { primary: true }]);
});

test('an owed read check survives a failed check and a return to the same chat', async () => {
  const failures = [];
  const state = { background: new Set(), capacity: 1, metrics: { failure: (name, error) => failures.push(error.message) } };
  const device = new Device(state, { userId: 'u' }, 0);
  device.selected = { id: 'chat' };
  const calls = [];
  let release;
  device.sync = () => {
    calls.push(device.selection);
    if (calls.length === 1) return new Promise((resolve, reject) => { release = reject; });
    return Promise.resolve();
  };
  const running = device.recheckReads('chat');
  await new Promise(resolve => setImmediate(resolve));
  device.selection += 2;
  device.recheckReads('chat');
  release(new Error('state unavailable'));
  await running;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(calls, [0, 2]);
  assert.deepEqual(failures, ['state unavailable']);
});

test('a lone read hint whose check fails is retried a bounded number of times', async () => {
  const state = { background: new Set(), capacity: 1, metrics: { failure: () => {} } };
  const device = new Device(state, { userId: 'u' }, 0);
  device.selected = { id: 'chat' };
  let calls = 0;
  device.sync = () => {
    calls++;
    return calls < 3 ? Promise.reject(new Error('state unavailable')) : Promise.resolve();
  };
  device.recheckReads('chat');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(calls, 3);
});

test('the first selected chat checks state before the periodic interval elapses', async () => {
  const state = { background: new Set(), metrics: new Measurements() };
  const device = new Device(state, {}, 0);
  const chat = { id: 'chat', members: [{ id: 'member' }] };
  device.selected = chat;
  device.socket = { opened: true, ws: { readyState: WebSocket.OPEN } };
  device.offerWatch = () => {};
  const calls = [];
  device.sync = async id => { calls.push(id); device.view(id).stateAt = performance.now(); };
  await device.refreshFeatures(chat);
  await device.refreshFeatures(chat);
  assert.deepEqual(calls, ['chat']);
});

test('a selected recovery failure checks primary state as well as uncertain sends', async () => {
  const state = { background: new Set(), capacity: 1, metrics: new Measurements() };
  const device = new Device(state, {}, 0);
  device.selected = { id: 'chat' };
  const calls = [];
  device.sync = async (id, options) => { calls.push([id, options]); };
  device.reconcile = async () => {};
  device.onFrame({ type: 'recovery_failed', chatId: 'chat' });
  await Promise.all([...state.background]);
  assert.deepEqual(calls, [['chat', { primary: true }]]);
});

test('initial state waits for the in-flight history page before deciding on catch-up', async () => {
  const state = { background: new Set(), capacity: 1, metrics: new Measurements(), recovered() {}, readNotification() {} };
  const device = new Device(state, {}, 0);
  device.socket = { opened: true, ws: { readyState: WebSocket.OPEN }, send() {} };
  device.offerWatch = () => {};
  let release;
  let stateRead;
  const observed = new Promise(resolve => { stateRead = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let pages = 0;
  device.get = async path => {
    if (path.endsWith('/state')) {
      stateRead();
      return { lastSeq: '1', mutationSeq: '0', memberSeq: '0', visibilitySeq: '0', pinsSeq: '0', memberPinsSeq: '0', ownReadThrough: '0', otherReadThrough: '0' };
    }
    if (path.includes('/messages/changes')) return { lastSeq: '0', nextSeq: '0', hasMore: false, resetRequired: false, changes: [] };
    assert.match(path, /\/messages$/);
    pages++;
    await blocked;
    return { messages: [], coverageThroughSequence: '1', mutationSeq: '0', visibilitySeq: '0' };
  };
  const opening = device.openChat({ id: 'chat', kind: 'DIRECT', members: [{ id: 'peer' }] }, performance.now());
  await observed;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pages, 1);
  release();
  await opening;
  while (state.background.size) await Promise.all([...state.background]);
  assert.equal(pages, 1);
});

test('merging old and corrected reports fails regardless of input order', () => {
  const metrics = new Measurements().raw();
  const current = { format: 'messenger-realistic-load-report-v2', rawMetrics: metrics, verificationRawMetrics: metrics };
  const old = { format: 'messenger-realistic-load-report-v1', rawMetrics: metrics };
  for (const parts of [[current, old], [old, current]]) assert.throws(() => mergeReports(parts), { code: 'shardReports' });
});
