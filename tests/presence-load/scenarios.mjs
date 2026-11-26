// The timed scenarios. Each returns its window reports and any failed checks.
import { setTimeout as delay } from 'node:timers/promises';
import { docker, waitHealthy } from './run.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
// Longer than the 15 s delivery deadline, so reconnecting never cuts an
// offline measurement short.
const OFFLINE_MS = 20 * SECOND;
// Probe actors stay online at least this long between cycles, so a poll-based
// build has several chances to see each online period.
const MIN_ONLINE_MS = 40 * SECOND;
const CYCLE_MS = OFFLINE_MS + MIN_ONLINE_MS;

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

// Cycles actors at `perSecond`, capped so each one stays online MIN_ONLINE_MS
// between cycles. Returns once scheduling stops.
function cycles(bench, users, ms, perSecond, label) {
  const rate = Math.min(perSecond, users.length * 1000 / CYCLE_MS);
  return bench.pace(ms, rate, users, actor => bench.cycle(actor, OFFLINE_MS, label));
}

const errors = report => Object.entries(report.counts).filter(([name]) => name.startsWith('errors.')).reduce((sum, [, value]) => sum + value, 0);

export async function smoke(bench) {
  const users = await start(bench, 64, MINUTE);
  const failures = [];
  const probe = await bench.measure('smoke', 90 * SECOND, () => cycles(bench, actors(bench, users, 8), 90 * SECOND, 1));
  if (probe.sockets.ready !== probe.sockets.live) failures.push(`${probe.sockets.ready}/${probe.sockets.live} live sockets ready`);
  for (const kind of ['online', 'offline']) {
    const outcome = probe.changes[kind];
    if (!outcome?.delivered || outcome.missing || outcome.late) failures.push(`${kind} changes: ${JSON.stringify(outcome)}`);
  }
  // A watch for a stranger, who shares no chat with the watcher, must not reveal their status.
  const watcher = users[0];
  const contacts = new Set([...bench.plan.peers[watcher].map(entry => entry.peer), ...bench.plan.groups[bench.plan.groupOf[watcher]].members]);
  const stranger = bench.plan.order.find(user => !contacts.has(user));
  const strangerId = bench.plan.users[stranger].id;
  bench.begin('smoke-stranger');
  if (bench.protocol === 'legacy') {
    const foreign = bench.plan.groups[bench.plan.groupOf[stranger]].id;
    bench.client(watcher).send({ type: 'watch_presence', version: 1, chatId: foreign, userIds: [strangerId] });
  } else {
    bench.client(watcher).send({ type: 'watch_presence', version: 1, add: [strangerId] });
  }
  await delay(5 * SECOND);
  const denial = await bench.end();
  for (const report of [probe, denial]) {
    if (report.counts['presence.unexpectedSubject']) failures.push(`${report.name}: status for a user outside the watch set`);
  }
  if (!denial.counts['presence.denied'] && !denial.counts['errors.UNAUTHORIZED']) failures.push('stranger watch was neither denied nor refused');
  return { windows: [probe, denial], failures };
}

export async function idle(bench, { plateaus = [1000, 2000, 3500] } = {}) {
  const windows = [];
  for (const size of plateaus) {
    const users = await start(bench, size);
    windows.push(await bench.measure(`quiet-${size}`, MINUTE));
    // Ordinary actors, plus the hot subjects, each of which more than 500
    // sockets per gateway watch at the top plateau.
    windows.push(await bench.measure(`idle-${size}`, 3 * MINUTE, () => Promise.all([
      cycles(bench, actors(bench, users, 32), 3 * MINUTE, 0.5),
      cycles(bench, bench.plan.hot, 3 * MINUTE, 1, 'hot'),
    ])));
  }
  return { windows };
}

export async function churn(bench, { size = 1600, rates = [2, 10, 25], activityRates = [5, 25, 100] } = {}) {
  const users = await start(bench, size);
  const hot = new Set(bench.plan.hot);
  const ordinary = users.filter(user => !hot.has(user));
  const windows = [];
  for (const rate of rates) {
    windows.push(await bench.measure(`churn-${rate}`, 2 * MINUTE, () => cycles(bench, ordinary, 2 * MINUTE, rate)));
    await delay(30 * SECOND);
  }
  if (bench.protocol !== 'current') return { windows };
  // An actor stops interacting for 20 s, then resumes; its tab stays visible.
  const toggle = async actor => {
    if (!bench.toggleActivity(actor, false)) return false;
    await delay(OFFLINE_MS);
    bench.toggleActivity(actor, true);
  };
  for (const rate of activityRates) {
    windows.push(await bench.measure(`activity-${rate}`, 2 * MINUTE, () => bench.pace(2 * MINUTE, rate / 2, ordinary, toggle)));
    await delay(30 * SECOND);
  }
  return { windows };
}

// Kills one gateway. Its sockets stay offline for the hold, so the surviving
// gateway's watchers must learn they went offline; then they reconnect while
// the failed gateway is still down, and finally it restarts.
export async function gatewayKill(bench, { size = 1600, container, holdMs = 150 * SECOND } = {}) {
  if (!container) throw new Error('--fault-container is required');
  await start(bench, size);
  const windows = [await bench.measure('before-gateway-kill', MINUTE)];
  const before = bench.open.map(client => client.index);
  bench.pauseReconnects = true;
  bench.begin('gateway-kill');
  const killedAt = performance.now();
  await docker('kill', container);
  await delay(2 * SECOND);
  const victims = before.filter(user => !bench.client(user).open);
  for (const victim of victims) bench.held.add(victim);
  bench.pauseReconnects = false;
  for (const victim of victims) bench.expect(victim, false, { at: killedAt, deadlineMs: holdMs });
  await delay(holdMs - (performance.now() - killedAt));
  windows.push(await bench.end({ victims: victims.length }));

  bench.begin('gateway-recovery');
  const started = performance.now();
  for (const victim of victims) bench.held.delete(victim);
  await bench.connect(victims, 50, victim => bench.expect(victim, true, { deadlineMs: 30 * SECOND }));
  const settled = await bench.settle(2 * MINUTE);
  const restored = victims.filter(victim => bench.client(victim).ready).length;
  windows.push(await bench.end({ victims: victims.length, restored, settled, restoreMs: Math.round(performance.now() - started) }));
  await docker('start', container);
  await waitHealthy(container);
  windows.push(await bench.measure('after-gateway-kill', MINUTE));
  return { windows };
}

// Kills one Redis primary while probe actors keep changing, then restarts it.
export async function redisKill(bench, { size = 1600, container, outageMs = 2 * MINUTE } = {}) {
  if (!container) throw new Error('--fault-container is required');
  const users = await start(bench, size);
  const probes = actors(bench, users, 64);
  const phases = [['before-redis-kill', 30 * SECOND], ['redis-outage', outageMs], ['redis-recovery', MINUTE], ['after-redis-kill', MINUTE]];
  const reports = [];
  for (const [name, ms] of phases) {
    bench.begin(name);
    if (name === 'redis-outage') await docker('kill', container);
    if (name === 'redis-recovery') await docker('start', container);
    await cycles(bench, probes, ms, 1);
    // Not awaited, so the next phase starts on time while this one resolves.
    reports.push(bench.end());
  }
  return { windows: await Promise.all(reports) };
}

export async function capacity(bench, { stages = [2000, 4000, 8000, 12000, 15000] } = {}) {
  const windows = [];
  for (const size of stages) {
    // The ramp is its own window, so watch refusals during admission count.
    bench.begin(`ramp-${size}`);
    await start(bench, size, 3 * MINUTE);
    const ramp = await bench.end({ target: size });
    const report = await bench.measure(`capacity-${size}`, 2 * MINUTE, undefined, { target: size });
    const refused = errors(ramp) + errors(report);
    report.passed = report.sockets.open >= 0.99 * size && report.sockets.ready >= 0.99 * size && refused <= 0.01 * size;
    report.refused = refused;
    windows.push(ramp, report);
    if (!report.passed) break;
  }
  return { windows };
}

export const SCENARIOS = { smoke, idle, churn, 'gateway-kill': gatewayKill, 'redis-kill': redisKill, capacity };
