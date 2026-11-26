import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from './client.mjs';
import { buildPlan, LEGACY_SIDEBAR_LIMIT, watchSet } from './plan.mjs';
import { Bench } from './run.mjs';

const small = { seed: 7, users: 256, degree: 6, hotSubjects: 2, hotFollowers: 40, hotPool: 128, groupSize: 64 };
const isId = value => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);

test('the plan is deterministic and stays within both builds\' watch limits', () => {
  const plan = buildPlan(small);
  const again = buildPlan(small);
  assert.deepEqual(plan.users, again.users);
  assert.deepEqual(plan.directs, again.directs);
  assert.deepEqual(plan.order, again.order);

  const ids = [...plan.users.map(user => user.id), ...plan.directs.map(chat => chat.id), ...plan.groups.map(group => group.id)];
  assert.ok(ids.every(isId));
  assert.equal(new Set(ids).size, ids.length);

  for (const chat of plan.directs) {
    assert.ok(plan.users[chat.low].id < plan.users[chat.high].id);
    assert.ok(plan.peers[chat.low].some(entry => entry.peer === chat.high && entry.chat === chat.id));
    assert.ok(plan.peers[chat.high].some(entry => entry.peer === chat.low && entry.chat === chat.id));
  }
  for (const [user, peers] of plan.peers.entries()) {
    if (!plan.hot.includes(user)) assert.ok(peers.length <= LEGACY_SIDEBAR_LIMIT);
    const watch = watchSet(plan, user);
    assert.ok(watch.directChats.length <= LEGACY_SIDEBAR_LIMIT);
    assert.ok(watch.subjects.length <= 232);
    assert.ok(!watch.subjects.includes(user));
  }
  // Every user belongs to exactly one group, and the cohort opens it.
  assert.deepEqual(plan.groups.flatMap(group => group.members).sort((a, b) => a - b), [...plan.users.keys()]);
  const opener = plan.order[0];
  assert.equal(watchSet(plan, opener).group, plan.groups[plan.groupOf[opener]]);
  assert.equal(watchSet(plan, plan.order[1]).group, null);
});

test('hot subjects are watched by their followers from the top plateau', () => {
  const plan = buildPlan(small);
  const pool = new Set(plan.order.slice(0, small.hotPool));
  for (const subject of plan.hot) {
    const followers = plan.peers[subject].filter(entry => pool.has(entry.peer));
    assert.ok(followers.length >= small.hotFollowers);
  }
});

function fakeHub(plan) {
  const ids = new Map(plan.users.map((user, index) => [user.id, index]));
  const hub = { counts: {}, statuses: [], readies: 0 };
  Object.assign(hub, {
    count: (name, amount = 1) => { hub.counts[name] = (hub.counts[name] ?? 0) + amount; },
    userIndex: id => ids.get(id),
    frame() {},
    status: (client, subject, online, prior) => hub.statuses.push([subject, online, prior]),
    ready: () => { hub.readies++; },
  });
  return hub;
}

function client(protocol, plan, user, hub) {
  const watch = watchSet(plan, user);
  const created = new Client({ index: user, plan, watch, protocol, hub });
  created.openedAt = 0;
  return created;
}

const frame = value => Buffer.from(JSON.stringify(value));

test('the legacy adapter reads sidebar and open-chat polls', () => {
  const plan = buildPlan(small);
  const hub = fakeHub(plan);
  const user = plan.order[0];
  const watcher = client('legacy', plan, user, hub);
  const [first, ...rest] = watcher.watch.subjects;
  const stranger = plan.users.findIndex((_, index) => index !== user && !watcher.expected.has(index));
  watcher.receive(frame({ type: 'sidebar_presence', version: 1, statuses: [
    { userId: plan.users[first].id, state: 'online' },
    { userId: plan.users[stranger].id, state: 'offline' },
  ] }));
  assert.deepEqual(hub.statuses, [[first, true, undefined]]);
  assert.equal(hub.counts['presence.unexpectedSubject'], 1);
  // A repeated poll is not a change; unknown says nothing.
  watcher.receive(frame({ type: 'presence', version: 1, statuses: [
    { userId: plan.users[first].id, state: 'online' },
    { userId: plan.users[rest[0]].id, state: 'unknown' },
  ] }));
  assert.equal(hub.statuses.length, 1);
  assert.equal(hub.readies, 0);
  watcher.receive(frame({ type: 'sidebar_presence', version: 1,
    statuses: watcher.watch.subjects.map(subject => ({ userId: plan.users[subject].id, state: subject === first ? 'offline' : 'online' })) }));
  assert.deepEqual(hub.statuses[1], [first, false, true]);
  assert.equal(hub.readies, 1);
});

test('the current adapter reads statuses and treats a denial as no state', () => {
  const plan = buildPlan(small);
  const hub = fakeHub(plan);
  const watcher = client('current', plan, plan.order[1], hub);
  const [first] = watcher.watch.subjects;
  const stranger = plan.users.findIndex((_, index) => index !== plan.order[1] && !watcher.expected.has(index));
  watcher.receive(frame({ type: 'presence', version: 1, statuses: [{ userId: plan.users[first].id, online: true }],
    unavailable: [plan.users[stranger].id] }));
  assert.deepEqual(hub.statuses, [[first, true, undefined]]);
  assert.equal(hub.counts['presence.denied'], 1);
  assert.equal(hub.counts['presence.unexpectedSubject'], undefined);
  watcher.receive(frame({ type: 'presence', version: 1, statuses: [], unavailable: [plan.users[first].id] }));
  assert.equal(watcher.known.has(first), false);
});

test('a change counts as delivered, missing, superseded or closed per watcher', async t => {
  const plan = buildPlan(small);
  const bench = new Bench({ plan, protocol: 'current', url: 'ws://unused', origin: 'https://unused', tickets: new Map(), log: () => {}, deadlineMs: 40 });
  t.after(() => bench.close());
  const actor = plan.order[5];
  const [w1, w2, w3] = bench.watchers[actor];
  for (const watcher of [w1, w2, w3]) {
    const fake = bench.client(watcher);
    fake.open = true;
    fake.known.set(actor, true);
  }
  // A watcher that already shows the new state is not armed.
  bench.client(w3).known.set(actor, false);
  const window = bench.begin('test');
  bench.expect(actor, false);
  assert.equal(window.changes.offline.armed, 2);
  bench.status(bench.client(w1), actor, false, true, performance.now());
  bench.client(w2).open = false;
  bench.closed(bench.client(w2), 1006, false, false);
  assert.equal(window.changes.offline.delivered, 1);
  assert.equal(window.changes.offline.watcherClosed, 1);

  // Both remaining watchers show offline now, so both wait for online.
  bench.client(w1).known.set(actor, false);
  bench.expect(actor, true);
  assert.equal(window.changes.online.armed, 2);
  bench.expect(actor, false);
  assert.equal(window.changes.online.superseded, 2);
  // Nobody shows online, so the last change armed no one; then one expires.
  assert.equal(bench.pending.size, 0);
  bench.client(w1).known.set(actor, true);
  bench.expect(actor, false);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(window.changes.offline.missing, 1);
  assert.equal(bench.pending.size, 0);
  bench.window = null;
});
