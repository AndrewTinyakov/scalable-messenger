import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
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
