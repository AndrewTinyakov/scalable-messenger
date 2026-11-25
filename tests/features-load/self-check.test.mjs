import test from 'node:test';
import assert from 'node:assert/strict';
import presence from '../../contracts/fixtures/valid/socket-presence.json' with { type: 'json' };
import onlineCount from '../../contracts/fixtures/valid/online-count.json' with { type: 'json' };
import presenceConfig from '../../contracts/fixtures/valid/presence-config.json' with { type: 'json' };
import { Histogram, Metrics } from './metrics.mjs';
import { plan, offeredAt, bounded } from './plan.mjs';
import { Driver } from './driver.mjs';
import { assess } from './assessment.mjs';

test('a long observation stream keeps a fixed histogram and correct tails', () => {
  const histogram = new Histogram();
  for (let i = 0; i < 100000; i++) histogram.observe(i % 100 === 0 ? 900 : 5);
  const result = histogram.report();
  assert.equal(histogram.buckets.length, 64);
  assert.equal(result.count, 100000);
  assert.equal(result.meanMs, 13.95);
  assert.ok(result.p95UpperMs >= 5 && result.p95UpperMs < 10);
  assert.ok(result.p99UpperMs >= 5 && result.p99UpperMs < 10);
  assert.equal(result.maxMs, 900);
});

test('large mixed plans cover every account and cap each membership/watch budget', () => {
  const chats = plan(1000, 'mixed', 1103);
  assert.deepEqual(chats, plan(1000, 'mixed', 1103));
  assert.notDeepEqual(chats, plan(1000, 'mixed', 1104));
  assert.equal(chats.filter(chat => chat.cohort === 'direct').length, 500);
  assert.equal(chats.filter(chat => chat.cohort === 'small').length, 125);
  assert.equal(chats.find(chat => chat.cohort === 'large').members.length, 1000);
  for (let account = 0; account < 1000; account++) {
    const memberships = chats.filter(chat => chat.members.includes(account));
    assert.equal(memberships.length, 3);
    assert.ok(memberships.every(chat => new Set(chat.members).size === chat.members.length));
  }
  assert.equal(offeredAt(120000, 2), 240);
  assert.equal(offeredAt(1000, .5), 0);
});

test('work runners bound concurrency and join owned work', async () => {
  let active = 0;
  let peak = 0;
  const completed = new Set();
  await bounded(Array.from({ length: 100 }, (_, i) => i), 4, async index => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    completed.add(index);
    active--;
  });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(completed.size, 100);
});

test('a conflicting saved terminal fails while replayed notifications remain idempotent', () => {
  const metrics = new Metrics();
  const driver = new Driver({ seed: 1 }, metrics, {});
  const chat = { id: 'chat', members: [0, 1] };
  driver.sockets = [{ session: { userId: 'sender' } }, { session: { userId: 'reader' } }];
  driver.records.set('request', { chat, sender: 0, body: 'hello', started: 0, seen: new Uint8Array(2), received: 0, requestId: 'request' });
  const frame = { type: 'message_saved', chatId: 'chat', requestId: 'request', messageId: 'one', senderId: 'sender', body: 'hello', sequence: '1', createdAt: '2026-11-04T00:00:00Z' };
  driver.receive({ index: 1, session: driver.sockets[1].session }, frame, 10);
  driver.receive({ index: 1, session: driver.sockets[1].session }, frame, 20);
  assert.equal(metrics.counts['correctness.failed'] ?? 0, 0);
  assert.equal(driver.records.get('request').received, 1);
  assert.equal(metrics.counts['saved.duplicateNotification'], 1);
  driver.receive({ index: 1, session: driver.sockets[1].session }, { ...frame, messageId: 'two' }, 30);
  assert.equal(metrics.counts['correctness.failed'], 1);
});

test('presence snapshots and handshake events are checked before measurement', () => {
  const metrics = new Metrics();
  const driver = new Driver({ seed: 1 }, metrics, {});
  const watched = [...presence.statuses.map(status => status.userId), ...presence.unavailable];
  driver.foreground.set(0, { watchIds: new Set(watched) });
  const receive = event => driver.receive({ index: 0 }, event, 0);
  for (const event of [presence, onlineCount, presenceConfig, { ...onlineCount, online: 0 }, { ...presenceConfig, idleAfterHiddenMs: 0 }]) receive(event);
  assert.equal(metrics.counts['correctness.failed'] ?? 0, 0);

  const invalid = [
    { ...presence, observedAt: '2026-11-04T00:00:00Z' },
    { ...presence, statuses: [null] },
    { ...presence, statuses: [{ ...presence.statuses[0], online: 'true' }] },
    { ...presence, statuses: [{ ...presence.statuses[1], lastSeenAt: '2026-02-30T00:00:00Z' }] },
    { ...presence, statuses: [{ ...presence.statuses[1], lastSeen: 'recently' }] },
    { ...presence, statuses: [{ ...presence.statuses[2], lastSeen: 'unknown' }] },
    { ...presence, unavailable: [watched[0], watched[0]] },
    { ...presence, unavailable: ['00000000000000000000000001'] },
    { ...onlineCount, online: onlineCount.members + 1 },
    { ...presenceConfig, releaseAfterHiddenMs: null },
  ];
  for (const event of invalid) receive(event);
  assert.equal(metrics.counts['correctness.failed'], invalid.length);
});

test('mutation removals and certified empty history pages recover without inventing notifications', async () => {
  const metrics = new Metrics();
  const paths = [];
  const http = { request: async (_session, path) => {
    paths.push(path);
    if (path.includes('/changes?')) return { resetRequired: false, changes: [{ kind: 'REMOVED', messageId: 'removed', message: null, sequence: '3', revision: '1' }], nextRevision: '1', lastRevision: '1' };
    if (path.includes('afterSeq=0&')) return { messages: [], hasMore: true, nextSequence: '100', coverageAfterSequence: '0', coverageThroughSequence: '100' };
    assert.match(path, /afterSeq=100&/);
    return { messages: [{ id: 'survivor', chatId: 'chat', sequence: '200' }], hasMore: false, nextSequence: '200', coverageAfterSequence: '100', coverageThroughSequence: '200' };
  } };
  const driver = new Driver({ seed: 1 }, metrics, http);
  const socket = { index: 0, session: { userId: 'viewer' }, chats: new Map([['chat', { id: 'chat', baseline: '0', mutationBaseline: '0' }]]) };
  driver.expectedMutations.set('removed', { revision: '1', observed: new Set() });
  await driver.recover(socket);
  assert.equal(driver.expectedMutations.get('removed').observed.has(0), true);
  assert.equal(paths.length, 3);
  assert.equal(metrics.counts['correctness.failed'] ?? 0, 0);
  assert.equal(metrics.counts['saved.recoveredNotification'] ?? 0, 0);
});

test('a failed worker still joins concurrent owned work before rejecting', async () => {
  let joined = false;
  await assert.rejects(bounded([0, 1, 2], 2, async index => {
    if (index === 0) {
      await new Promise(resolve => setImmediate(resolve));
      throw new Error('failed');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    joined = true;
  }), /failed/);
  assert.equal(joined, true);
});

test('one shared ticket queue spaces all callers and never catches up in a burst', async () => {
  const { TicketAdmission } = await import('./tickets.mjs');
  let now = 0;
  const starts = [];
  let jumped = false;
  const admission = new TicketAdmission({ now: () => now, sleep: async ms => {
    await new Promise(resolve => setImmediate(resolve));
    if (!jumped) { now = 5000; jumped = true; }
    else now += ms;
  } });
  await Promise.all(Array.from({ length: 4 }, async () => {
    await admission.acquire();
    starts.push(now);
  }));
  await admission.join();
  assert.deepEqual(starts, [0, 5000, 5250, 5500]);
  assert.equal(admission.report().pending, 0);
  assert.equal(admission.report().admitted, 4);
  assert.equal(admission.report().peakPending, 4);
});

test('ticket admission rejects overflow, cancels waiting callers and joins its timer', async () => {
  const { TicketAdmission } = await import('./tickets.mjs');
  const admission = new TicketAdmission({ intervalMs: 10000, limit: 2 });
  await admission.acquire();
  const active = new AbortController();
  const queued = new AbortController();
  const first = admission.acquire(active.signal);
  await new Promise(resolve => setImmediate(resolve));
  const second = admission.acquire(queued.signal);
  await assert.rejects(admission.acquire(), /queue limit/);
  const firstRejected = assert.rejects(first, /cancel active/);
  const secondRejected = assert.rejects(second, /cancel queued/);
  queued.abort(new Error('cancel queued'));
  active.abort(new Error('cancel active'));
  await Promise.all([firstRejected, secondRejected, admission.join()]);
  assert.equal(admission.report().pending, 0);
  assert.equal(admission.report().admitted, 1);
  assert.equal(admission.report().cancelled, 2);
  assert.equal(admission.report().rejected, 1);
  assert.equal(admission.report().peakPending, 2);
});

test('briefly saturated admissions preserve due requests and coalesced read frontiers', async () => {
  const metrics = new Metrics();
  const accepted = [];
  let available = false;
  const http = { request: async (_, __, { body }) => ({ throughSequence: body.throughSequence, readAt: '2026-11-04T00:00:00Z', serverTime: '2026-11-04T00:00:00Z' }) };
  const driver = new Driver({ seed: 1, sendRate: 2, maxSends: 3 }, metrics, http);
  const chat = { id: 'chat', members: [0, 1], anchor: { id: 'anchor' }, cohort: 'direct' };
  driver.chats = [chat];
  driver.sockets = [0, 1].map(index => ({ index, session: { userId: String(index) }, send: frame => {
    if (!available) return false;
    accepted.push(frame.requestId);
    return true;
  } }));
  driver.foreground.set(1, { chat, through: '5', posted: '0', visibleSince: 1, nextAt: 0, busy: false });
  let release;
  const contention = new Promise(resolve => { release = resolve; });
  for (let i = 0; i < 32; i++) assert.equal(driver.launch('fixture', () => contention), true);
  driver.tickReads(1000);
  assert.equal(metrics.counts['read.admissionDeferred'], 1);
  assert.equal(driver.foreground.get(1).through, '5');
  assert.equal(driver.foreground.get(1).posted, '0');
  driver.sendSchedule.tick(0);
  driver.sendSchedule.tick(500);
  driver.sendSchedule.tick(1000);
  assert.equal(driver.sendSchedule.pending.length, 3);
  const retainedIds = driver.sendSchedule.pending.map(record => record.requestId);
  assert.equal(driver.records.size, 0);
  release();
  await Promise.allSettled([...driver.tasks]);
  available = true;
  driver.sendSchedule.flush(1200);
  driver.tickReads(1200);
  await Promise.allSettled([...driver.tasks]);
  assert.deepEqual(accepted, retainedIds);
  assert.equal(new Set(accepted).size, 3);
  assert.equal(driver.sendSchedule.pending.length, 0);
  assert.equal(driver.foreground.get(1).posted, '5');
  assert.equal(metrics.counts['send.offered'], 3);
  assert.equal(metrics.counts['send.dispatched'], 3);
  assert.equal(metrics.counts['send.deferred'], 3);
  assert.equal(metrics.counts['send.dropped'] ?? 0, 0);
  assert.equal(metrics.latencies.get('send.schedulingLag').report().maxMs, 1200);
  assert.equal(assess(metrics.counts).passed, true);
});

test('a disconnected sender does not block due work for other sockets', () => {
  const metrics = new Metrics();
  const accepted = [];
  const driver = new Driver({ seed: 1, sendRate: 2, maxSends: 2 }, metrics, {});
  driver.chats = [0, 1].map(index => ({ id: String(index), members: [index], anchor: { id: 'anchor' }, cohort: 'direct' }));
  driver.sockets = [0, 1].map(index => ({ session: { userId: String(index) }, send: () => { if (index === 1) accepted.push(index); return index === 1; } }));
  driver.sendSchedule.tick(0);
  driver.sendSchedule.tick(500);
  assert.deepEqual(accepted, [1]);
  assert.equal(driver.sendSchedule.pending.length, 1);
  assert.equal(driver.sendSchedule.pending[0].sender, 0);
});

test('bounded backlog overload, expiry and any offered send loss fail assessment', () => {
  const metrics = new Metrics();
  const driver = new Driver({ seed: 1, sendRate: 100, maxSends: 200 }, metrics, {});
  driver.chats = [{ id: 'chat', members: [0], anchor: { id: 'anchor' }, cohort: 'direct' }];
  driver.sockets = [{ session: { userId: 'sender' }, send: () => false }];
  driver.sendSchedule.tick(0);
  driver.sendSchedule.tick(1000);
  assert.equal(driver.sendSchedule.pending.length, 64);
  assert.equal(driver.sendSchedule.report().peakPending, 64);
  assert.equal(metrics.counts['send.offered'], 101);
  assert.equal(metrics.counts['send.backlogOverflow'], 37);
  assert.equal(assess(metrics.counts).passed, false);
  driver.sendSchedule.expire();
  assert.equal(driver.sendSchedule.pending.length, 0);
  assert.equal(metrics.counts['send.backlogExpired'], 64);
  assert.equal(metrics.counts['send.dropped'], 101);
  assert.equal(assess(metrics.counts).passed, false);
  assert.equal(assess({ 'send.offered': 180, 'send.dispatched': 179, 'send.driverDropped': 1 }).passed, false);
  assert.equal(assess({ 'send.offered': 180, 'send.dispatched': 179 }).passed, false);
  assert.equal(assess({ 'send.offered': 180, 'send.dispatched': 180, 'read.pendingAtEnd': 1 }).passed, false);
});

test('the measurement drain posts the last incoming frontier after its foreground dwell', async () => {
  const metrics = new Metrics();
  const reads = [];
  const http = { request: async (_, path, options) => {
    reads.push({ path, body: options.body });
    const now = new Date().toISOString();
    return { throughSequence: options.body.throughSequence, readAt: now, serverTime: now };
  } };
  const driver = new Driver({ seed: 1, sendRate: 50, maxSends: 1, duration: .02, drain: 1.5, reconnectFraction: 0 }, metrics, http);
  const chat = { id: 'chat', members: [0, 1], anchor: { id: 'anchor' }, cohort: 'direct' };
  driver.chats = [chat];
  driver.sockets = [0, 1].map(index => ({ index, session: { userId: String(index) }, send: frame => {
    queueMicrotask(() => {
      for (const socket of driver.sockets) driver.receive(socket, { ...frame, type: 'message_saved', messageId: 'message', senderId: '0', sequence: '1', createdAt: new Date().toISOString() }, performance.now());
    });
    return true;
  } }));
  driver.foreground.set(1, { chat, through: '0', posted: '0', visibleSince: 0, nextAt: 0, busy: false });
  driver.lookup = async () => {};
  driver.mutate = async () => {};
  driver.deleteDisposable = async () => {};
  await driver.run();
  assert.deepEqual(reads, [{ path: '/chats/chat/reads', body: { throughSequence: '1' } }]);
  assert.ok(driver.measurementMs < 200);
  assert.equal(driver.foreground.get(1).posted, '1');
  assert.equal(metrics.counts['read.pendingAtEnd'], 0);
  assert.equal(metrics.counts['send.offered'], 1);
  assert.equal(metrics.counts['send.dispatched'], 1);
  assert.equal(metrics.counts['send.saved'], 1);
  assert.equal(driver.tasks.size, 0);
  assert.equal(assess(metrics.counts).passed, true);
});
