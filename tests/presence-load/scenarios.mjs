// The timed scenarios. Each returns its window reports; durations are in ms.
import { setTimeout as delay } from 'node:timers/promises';
import { docker, waitHealthy } from './run.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OFFLINE_MS = 12 * SECOND;
// Probe actors stay online at least this long between cycles, so a poll-based
// build has several chances to see each online period.
const MIN_ONLINE_MS = 40 * SECOND;

const population = (bench, size) => bench.plan.order.slice(0, size);

// Probe actors: ordinary users (not hot subjects) that several connected users watch.
function actors(bench, users, count) {
  const connected = new Set(users);
  const hot = new Set(bench.plan.hot);
  const chosen = [];
  for (let i = users.length - 1; i >= 0 && chosen.length < count; i -= 7) {
    const user = users[i];
    if (!hot.has(user) && bench.watchers[user].filter(watcher => connected.has(watcher)).length >= 3) chosen.push(user);
  }
  return chosen;
}

async function start(bench, size, settleMs = 2 * MINUTE) {
  const users = population(bench, size);
  await bench.connect(users);
  const settled = await bench.settle(settleMs);
  bench.log(`[${size}] ${bench.open.length} open, settled: ${settled}`);
  return users;
}

// Cycles `perSecond` actors, capped so each one stays online MIN_ONLINE_MS
// between cycles.
function cycles(bench, users, ms, perSecond) {
  const rate = Math.min(perSecond, users.length * 1000 / (OFFLINE_MS + MIN_ONLINE_MS));
  if (rate < perSecond) bench.log(`cycling ${rate.toFixed(2)}/s instead of ${perSecond}/s: only ${users.length} actors`);
  return bench.pace(ms, rate, users, actor => bench.cycle(actor, OFFLINE_MS));
}

export async function smoke(bench) {
  const users = await start(bench, 64, MINUTE);
  const reports = [await bench.measure('smoke', MINUTE, () => cycles(bench, actors(bench, users, 8), MINUTE, 0.5))];
  // A watch for a stranger must not reveal their status.
  const watcher = bench.client(users[0]);
  const stranger = bench.plan.order.find(user => !bench.watches[users[0]].subjects.includes(user) && user !== users[0] &&
    bench.plan.groupOf[user] !== bench.plan.groupOf[users[0]]);
  const strangerId = bench.plan.users[stranger].id;
  bench.begin('smoke-stranger');
  if (bench.protocol === 'legacy') {
    const foreign = bench.plan.groups[bench.plan.groupOf[stranger]].id;
    watcher.send({ type: 'watch_presence', version: 1, chatId: foreign, userIds: [strangerId] });
  } else {
    watcher.send({ type: 'watch_presence', version: 1, add: [strangerId] });
  }
  await delay(5 * SECOND);
  reports.push(await bench.end());
  return reports;
}

export async function idle(bench, { plateaus = [1000, 2000, 3500] } = {}) {
  const reports = [];
  for (const size of plateaus) {
    const users = await start(bench, size);
    reports.push(await bench.measure(`quiet-${size}`, MINUTE));
    reports.push(await bench.measure(`idle-${size}`, 3 * MINUTE, () => cycles(bench, actors(bench, users, 32), 3 * MINUTE, 0.5)));
  }
  return reports;
}

export async function churn(bench, { size = 1600, rates = [2, 10, 40], activityRates = [5, 25, 100] } = {}) {
  const users = await start(bench, size);
  const hot = new Set(bench.plan.hot);
  const ordinary = users.filter(user => !hot.has(user));
  const reports = [];
  for (const rate of rates) {
    reports.push(await bench.measure(`churn-${rate}`, 2 * MINUTE, () => cycles(bench, ordinary, 2 * MINUTE, rate)));
    await bench.settle(30 * SECOND);
  }
  if (bench.protocol !== 'current') return reports;
  // An activity change makes the user idle for 10 s, then active again.
  const toggle = async actor => {
    await bench.toggleActivity(actor, false);
    await delay(10 * SECOND);
    await bench.toggleActivity(actor, true);
  };
  for (const rate of activityRates) {
    reports.push(await bench.measure(`activity-${rate}`, 2 * MINUTE, () => bench.pace(2 * MINUTE, rate / 2, ordinary, toggle)));
    await delay(15 * SECOND);
  }
  return reports;
}

export async function gatewayKill(bench, { size = 1600, container, holdMs = 150 * SECOND } = {}) {
  if (!container) throw new Error('--fault-container is required');
  await start(bench, size);
  const reports = [await bench.measure('before-gateway-kill', MINUTE)];
  const victims = [];
  let killedAt = null;
  // Sockets the kill closes stay offline until the hold ends; their watchers
  // on the surviving gateway must see them go offline.
  bench.onClose = (client, expected, wasOpen) => {
    if (killedAt === null || expected || !wasOpen) return;
    victims.push(client.index);
    bench.held.add(client.index);
    bench.expect(client.index, false, killedAt, holdMs);
  };
  const deadline = bench.deadlineMs;
  bench.begin('gateway-kill');
  killedAt = performance.now();
  await docker('kill', container);
  await delay(holdMs);
  bench.onClose = null;
  reports.push(await bench.end({ victims: victims.length }));
  await docker('start', container);
  await waitHealthy(container);
  bench.begin('gateway-recovery');
  for (const victim of victims) bench.held.delete(victim);
  bench.deadlineMs = 30 * SECOND;
  for (const victim of victims) bench.expect(victim, true);
  const started = performance.now();
  await bench.connect(victims, 50);
  const settled = await bench.settle(2 * MINUTE);
  reports.push(await bench.end({ victims: victims.length, settled, restoreMs: performance.now() - started }));
  bench.deadlineMs = deadline;
  reports.push(await bench.measure('after-gateway-kill', MINUTE));
  return reports;
}

export async function redisKill(bench, { size = 1600, container, outageMs = 2 * MINUTE } = {}) {
  if (!container) throw new Error('--fault-container is required');
  const users = await start(bench, size);
  const probes = actors(bench, users, 64);
  const phases = [['before-redis-kill', 30 * SECOND], ['redis-outage', outageMs], ['redis-recovery', MINUTE], ['after-redis-kill', MINUTE]];
  const total = phases.reduce((sum, [, ms]) => sum + ms, 0);
  const probing = cycles(bench, probes, total, 1);
  const reports = [];
  for (const [name, ms] of phases) {
    bench.begin(name);
    if (name === 'redis-outage') await docker('kill', container);
    if (name === 'redis-recovery') await docker('start', container);
    await delay(ms);
    // Not awaited, so the next window starts on time while this one resolves.
    reports.push(bench.end());
  }
  await probing;
  return Promise.all(reports);
}

export async function capacity(bench, { stages = [2000, 4000, 8000, 12000, 15000] } = {}) {
  const reports = [];
  for (const size of stages) {
    await start(bench, size, 3 * MINUTE);
    const report = await bench.measure(`capacity-${size}`, 2 * MINUTE, undefined, { target: size });
    report.passed = report.sockets.open >= 0.99 * size && report.sockets.ready >= 0.99 * size;
    reports.push(report);
    if (!report.passed) break;
  }
  return reports;
}

export const SCENARIOS = { smoke, idle, churn, 'gateway-kill': gatewayKill, 'redis-kill': redisKill, capacity };
