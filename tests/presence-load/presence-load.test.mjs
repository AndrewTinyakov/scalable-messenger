import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from './client.mjs';
import { buildPlan, LEGACY_SIDEBAR_LIMIT, watchSet } from './plan.mjs';
import { Bench, percentiles, score } from './run.mjs';

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
    // The current API's 8 KiB request limit fits about 232 IDs in one visibility RPC.
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
  created.open = true;
  created.openedAt = 0;
  return created;
}

const frame = value => Buffer.from(JSON.stringify(value));
const poll = (type, statuses, observedAt = new Date()) => frame({ type, version: 1, observedAt: observedAt.toISOString(), validForMs: 15000, statuses });

test('the legacy adapter reads sidebar and open-chat polls', () => {
  const plan = buildPlan(small);
  const hub = fakeHub(plan);
  const user = plan.order[0];
  const watcher = client('legacy', plan, user, hub);
  const [first, ...rest] = watcher.watch.subjects;
  const stranger = plan.users.findIndex((_, index) => index !== user && !watcher.expected.has(index));
  watcher.receive(poll('sidebar_presence', [
    { userId: plan.users[first].id, state: 'online' },
    { userId: plan.users[stranger].id, state: 'offline' },
  ]));
  assert.deepEqual(hub.statuses, [[first, true, undefined]]);
  assert.equal(hub.counts['presence.unexpectedSubject'], 1);
  // A repeated poll is not a change; unknown says nothing.
  watcher.receive(poll('presence', [
    { userId: plan.users[first].id, state: 'online' },
    { userId: plan.users[rest[0]].id, state: 'unknown' },
  ]));
  assert.equal(hub.statuses.length, 1);
  assert.equal(hub.readies, 0);
  const all = state => watcher.watch.subjects.map(subject => ({ userId: plan.users[subject].id, state: subject === first ? 'offline' : state }));
  // An expired poll is dropped.
  watcher.receive(poll('sidebar_presence', all('online'), new Date(Date.now() - 20_000)));
  assert.equal(hub.statuses.length, 1);
  assert.equal(hub.counts['presence.staleFrame'], 1);
  watcher.receive(poll('sidebar_presence', all('online')));
  assert.deepEqual(hub.statuses[1], [first, false, true]);
  assert.equal(hub.readies, 1);
  // Its sidebar poll runs out after validForMs.
  watcher.validUntil.sidebar = Date.now() - 1;
  assert.equal(watcher.ready, false);
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

test('the current adapter is ready only once its group count arrives', () => {
  const plan = buildPlan(small);
  const hub = fakeHub(plan);
  const watcher = client('current', plan, plan.order[0], hub);
  watcher.receive(frame({ type: 'presence', version: 1,
    statuses: watcher.watch.subjects.map(subject => ({ userId: plan.users[subject].id, online: false })) }));
  assert.equal(watcher.ready, false);
  watcher.receive(frame({ type: 'online_count', version: 1, chatId: watcher.watch.group.id, online: 0, members: 64 }));
  assert.equal(watcher.ready, true);
  assert.equal(hub.readies, 1);
  // Losing a state makes the socket not ready again.
  watcher.receive(frame({ type: 'presence', version: 1, statuses: [], unavailable: [plan.users[watcher.watch.subjects[0]].id] }));
  assert.equal(watcher.ready, false);
});

function bench(t, deadlineMs) {
  const plan = buildPlan(small);
  const created = new Bench({ plan, protocol: 'current', url: 'ws://unused', origin: 'https://unused', ticket: () => '', log: () => {}, deadlineMs });
  t.after(() => created.close());
  return created;
}

// Three open watchers of one actor that all show it online.
function watched(created) {
  const actor = created.plan.order[5];
  const watchers = created.watchers[actor].slice(0, 3);
  for (const watcher of watchers) {
    const fake = created.client(watcher);
    fake.open = true;
    fake.known.set(actor, true);
  }
  return { actor, watchers, client: watcher => created.client(watcher) };
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('each watcher of a change ends delivered, closed or already showing it', async t => {
  const created = bench(t, 30);
  const { actor, watchers: [w1, w2, w3], client: get } = watched(created);
  get(w3).known.set(actor, false);
  // A watcher without a known state still has to learn the new one.
  get(w2).known.delete(actor);
  const window = created.begin('test');
  created.expect(actor, false);
  assert.deepEqual(window.changes.offline, { armed: 2, delivered: 0, late: 0, missing: 0, superseded: 0, watcherClosed: 0, alreadyShown: 1 });
  created.status(get(w1), actor, false, true, performance.now());
  get(w2).open = false;
  created.closed(get(w2), 1006, false, false);
  // A delivery counts once its watcher has stayed connected until the deadline.
  assert.equal(window.changes.offline.delivered, 0);
  await tick(40);
  assert.equal(window.changes.offline.delivered, 1);
  assert.equal(window.changes.offline.watcherClosed, 1);
  assert.equal(created.pending.size, 0);
  created.window = null;
});

test('a delivery past the deadline settles earlier ones before the change ends', t => {
  const created = bench(t, 20);
  const { actor, watchers: [w1, w2, w3], client: get } = watched(created);
  const window = created.begin('test');
  created.expect(actor, false);
  const start = performance.now();
  created.status(get(w1), actor, false, true, start);
  get(w3).open = false;
  created.closed(get(w3), 1006, false, false);
  // The last watcher reports after the deadline, before any timer has run.
  created.status(get(w2), actor, false, true, start + 50);
  assert.equal(created.pending.size, 0);
  assert.equal(window.changes.offline.delivered, 1);
  assert.equal(window.changes.offline.late, 1);
  assert.equal(window.samples.get('delivery.offline').length, 1);
  created.window = null;
});

test('a report after the grace is missing, and the last close after the deadline ends the change', t => {
  const created = bench(t, 20);
  const { actor, watchers: [w1, w2, w3], client: get } = watched(created);
  const window = created.begin('test');
  const at = performance.now() - 100_000;
  created.expect(actor, false, { at });
  created.status(get(w1), actor, false, true, performance.now());
  assert.equal(window.changes.offline.late, 0);
  assert.equal(window.changes.offline.missing, 3);
  assert.equal(created.pending.size, 0);
  created.expect(actor, false, { at: performance.now() - 50 });
  created.status(get(w1), actor, false, true, performance.now());
  get(w2).open = false;
  created.closed(get(w2), 1006, false, false);
  assert.equal(created.pending.size, 1);
  get(w3).open = false;
  created.closed(get(w3), 1006, false, false);
  assert.equal(created.pending.size, 0);
  created.window = null;
});

test('readiness settling still works alongside delivery settling', async t => {
  const created = bench(t, 20);
  assert.equal(await created.settle(10, []), true);
});

test('a watcher that closes before the deadline is not scored, even after its frame arrived', async t => {
  const created = bench(t, 30);
  const { actor, watchers: [w1, w2], client: get } = watched(created);
  const window = created.begin('test');
  created.expect(actor, false);
  created.status(get(w1), actor, false, true, performance.now());
  get(w1).open = false;
  created.closed(get(w1), 1006, false, false);
  get(w2).open = false;
  created.closed(get(w2), 1006, false, false);
  await tick(40);
  const [{ changes: { offline } }] = score([window]);
  assert.equal(offline.delivered, 0);
  assert.equal(offline.watcherClosed, 2);
  assert.equal(offline.scored, 0);
  assert.equal(window.samples.get('delivery.offline'), undefined);
  created.window = null;
});

test('the on-time share leaves out watchers that closed and changes superseded in time', () => {
  const changes = { offline: { armed: 10, delivered: 3, late: 1, missing: 0, superseded: 2, watcherClosed: 4, alreadyShown: 5 } };
  const [{ changes: { offline } }] = score([{ changes }]);
  assert.equal(offline.scored, 4);
  assert.equal(offline.onTime, 0.75);
  assert.equal(score([{ changes: { online: { armed: 1, delivered: 0, late: 0, missing: 0, superseded: 0, watcherClosed: 1 } } }])[0].changes.online.onTime, null);
});

test('delivery percentiles come from raw samples', t => {
  assert.deepEqual(percentiles([]), {});
  const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(percentiles(samples), { p50Ms: 50, p90Ms: 90, p99Ms: 99 });
  const created = bench(t, 1000);
  const window = created.begin('test');
  for (const ms of [2105, 2110, 2300]) window.observe('delivery.offline', ms);
  assert.deepEqual(window.samples.get('delivery.offline'), [2105, 2110, 2300]);
  created.window = null;
});

test('a new change supersedes one still in time', t => {
  const created = bench(t, 1000);
  const { actor, watchers: [w1] } = watched(created);
  const window = created.begin('test');
  created.expect(actor, false);
  created.expect(actor, true);
  assert.equal(window.changes.offline.superseded, 3);
  assert.equal(window.changes.online.alreadyShown, 3);
  assert.equal(created.pending.size, 0);
  created.window = null;
});

test('a delivery after the deadline counts as late, not delivered', async t => {
  const created = bench(t, 20);
  const { actor, watchers: [w1, w2], client: get } = watched(created);
  const window = created.begin('test');
  // Backdated beyond its deadline: a report arriving now is late.
  created.expect(actor, false, { at: performance.now() - 50 });
  await tick(5);
  created.status(get(w1), actor, false, true, performance.now());
  assert.equal(window.changes.offline.late, 1);
  assert.equal(window.changes.offline.delivered, 0);
  // A watcher closing after the deadline never reported in time.
  get(w2).open = false;
  created.closed(get(w2), 1006, false, false);
  assert.equal(window.changes.offline.missing, 1);
  // A later change ends the expired one; its last watcher is missing, not superseded.
  created.expect(actor, true);
  assert.equal(window.changes.offline.superseded, 0);
  assert.equal(window.changes.offline.missing, 2);
  assert.deepEqual({ ...window.changes.offline, alreadyShown: 0 },
    { armed: 3, delivered: 0, late: 1, missing: 2, superseded: 0, watcherClosed: 0, alreadyShown: 0 });
  created.window = null;
});

test('a legacy source forgets its states once its polls expire', () => {
  const plan = buildPlan(small);
  const hub = fakeHub(plan);
  const watcher = client('legacy', plan, plan.order[0], hub);
  const { group, groupMembers, directChats } = watcher.watch;
  assert.ok(group && directChats.length);
  const direct = plan.peers[plan.order[0]].map(entry => entry.peer).find(peer => !groupMembers.includes(peer));
  const shared = groupMembers[0];
  watcher.receive(poll('sidebar_presence', [direct, shared].map(subject => ({ userId: plan.users[subject].id, state: 'online' }))));
  watcher.receive(poll('presence', [{ userId: plan.users[shared].id, state: 'offline' }]));
  assert.equal(watcher.known.get(shared), false);
  // The sidebar's polls stop: its direct peer is unknown again, while the open
  // group still vouches for the member both sources reported.
  watcher.validUntil.sidebar = Date.now() - 1;
  watcher.prune();
  assert.equal(watcher.known.has(direct), false);
  assert.equal(watcher.known.get(shared), false);
});

test('an empty group poll after a gap does not revive expired states', () => {
  const plan = buildPlan(small);
  const watcher = client('legacy', plan, plan.order[0], fakeHub(plan));
  const shared = watcher.watch.groupMembers[0];
  watcher.receive(poll('presence', [{ userId: plan.users[shared].id, state: 'online' }]));
  watcher.validUntil.group = Date.now() - 1;
  watcher.receive(poll('presence', []));
  assert.equal(watcher.known.has(shared), false);
});
