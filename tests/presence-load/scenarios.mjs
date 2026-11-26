// The timed scenarios. Each returns its window reports and any failed checks.
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

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

async function docker(...args) {
  const { stdout } = await run('docker', args);
  return stdout.trim();
}

async function waitHealthy(container, timeoutMs = 2 * MINUTE) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', container) === 'healthy') return;
    await delay(SECOND);
  }
  throw new Error(`${container} did not become healthy`);
}

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

// Connects the first `size` users and waits for them to be ready. A run whose
// population never settles measured less than its target, so it is marked
// failed unless the scenario judges that itself.
async function start(bench, size, settleMs = 2 * MINUTE, { required = true } = {}) {
  const users = population(bench, size);
  if (users.length < size) throw new Error(`the plan has ${users.length} users, fewer than the ${size} this stage needs`);
  await bench.connect(users);
  const settled = await bench.settle(settleMs);
  bench.log(`[${size}] ${bench.open.length} open, settled: ${settled}`);
  if (!settled && required) bench.failures.push(`${size} sockets did not become ready within ${settleMs / 1000} s`);
  return users;
}

// Cycles actors at `perSecond`, capped so each one stays online MIN_ONLINE_MS
// between cycles. Returns once scheduling stops.
function cycles(bench, users, ms, perSecond, label) {
  const rate = Math.min(perSecond, users.length * 1000 / CYCLE_MS);
  return bench.pace(ms, rate, users, (actor, window) => bench.cycle(actor, OFFLINE_MS, { label, window }));
}

const errors = report => Object.entries(report.counts).filter(([name]) => name.startsWith('errors.')).reduce((sum, [, value]) => sum + value, 0);

export async function smoke(bench) {
  const users = await start(bench, 64, MINUTE);
  const failures = bench.failures;
  const probe = await bench.measure('smoke', () => cycles(bench, actors(bench, users, 8), 90 * SECOND, 1));
  if (probe.sockets.ready !== probe.sockets.intended) failures.push(`${probe.sockets.ready}/${probe.sockets.intended} intended sockets ready`);
  // A watch for a stranger, who shares no chat with the watcher, must be
  // refused or denied without revealing their status.
  const watcher = users[0];
  const contacts = new Set([...bench.plan.peers[watcher].map(entry => entry.peer), ...bench.plan.groups[bench.plan.groupOf[watcher]].members]);
  const stranger = bench.plan.order.find(user => !contacts.has(user));
  const strangerId = bench.plan.users[stranger].id;
  const client = bench.client(watcher);
  const errorsBefore = client.errors.length;
  bench.begin('smoke-stranger');
  if (bench.protocol === 'legacy') {
    const foreign = bench.plan.groups[bench.plan.groupOf[stranger]].id;
    client.send({ type: 'watch_presence', version: 1, chatId: foreign, userIds: [strangerId] });
  } else {
    client.send({ type: 'watch_presence', version: 1, add: [strangerId] });
  }
  await delay(5 * SECOND);
  const denial = await bench.end();
  const refused = bench.protocol === 'legacy' ? client.errors.slice(errorsBefore).includes('UNAUTHORIZED') : client.denied.has(strangerId);
  if (!refused) failures.push('the stranger watch was neither refused nor denied');
  if (bench.counts['presence.unexpectedSubject']) failures.push('a status arrived for a user outside a watch set');
  // Outcomes are final only once every probe change has been reported or timed out.
  await bench.drain();
  for (const kind of ['online', 'offline']) {
    const outcome = probe.changes[kind];
    if (!outcome?.delivered || outcome.missing || outcome.late) failures.push(`${kind} changes: ${JSON.stringify(outcome)}`);
  }
  return [probe, denial];
}

export async function idle(bench, { plateaus = [1000, 2000, 3500] } = {}) {
  const windows = [];
  for (const size of plateaus) {
    const users = await start(bench, size);
    windows.push(await bench.measure(`quiet-${size}`, MINUTE));
    // Ordinary actors, plus the hot subjects, each of which more than 500
    // sockets per gateway watch at the top plateau.
    windows.push(await bench.measure(`idle-${size}`, () => Promise.all([
      cycles(bench, actors(bench, users, 32), 3 * MINUTE, 0.5),
      cycles(bench, bench.plan.hot, 3 * MINUTE, 1, 'hot'),
    ])));
  }
  return windows;
}

export async function churn(bench, { size = 1600, rates = [2, 10, 25], activityRates = [5, 25, 100] } = {}) {
  const users = await start(bench, size);
  const hot = new Set(bench.plan.hot);
  const ordinary = users.filter(user => !hot.has(user));
  const windows = [];
  for (const rate of rates) {
    windows.push(await bench.measure(`churn-${rate}`, () => cycles(bench, ordinary, 2 * MINUTE, rate)));
    await delay(30 * SECOND);
  }
  if (bench.protocol !== 'current') return windows;
  // An actor stops interacting for 20 s, then resumes; its tab stays visible.
  const toggle = async (actor, window) => {
    if (!bench.toggleActivity(actor, false, window)) return false;
    await delay(OFFLINE_MS);
    bench.toggleActivity(actor, true, window);
  };
  for (const rate of activityRates) {
    windows.push(await bench.measure(`activity-${rate}`, () => bench.pace(2 * MINUTE, rate / 2, ordinary, toggle)));
    await delay(30 * SECOND);
  }
  return windows;
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
  const settled = await bench.settle(2 * MINUTE, victims);
  const restoreMs = Math.round(performance.now() - started);
  const restored = victims.filter(victim => bench.client(victim).ready).length;
  windows.push(await bench.end({ victims: victims.length, restored, settled, restoreMs }));
  await docker('start', container);
  await waitHealthy(container);
  windows.push(await bench.measure('after-gateway-kill', MINUTE));
  if (!victims.length) bench.failures.push('the gateway kill closed no sockets');
  return windows;
}

// Kills one Redis primary while probe actors keep changing, then restarts it.
export async function redisKill(bench, { size = 1600, container, outageMs = 2 * MINUTE } = {}) {
  if (!container) throw new Error('--fault-container is required');
  const users = await start(bench, size);
  const probes = actors(bench, users, 64);
  const phases = [['before-redis-kill', 30 * SECOND], ['redis-outage', outageMs], ['redis-recovery', MINUTE], ['after-redis-kill', MINUTE]];
  const total = phases.reduce((sum, [, ms]) => sum + ms, 0);
  // One schedule runs through every phase, so each actor keeps its full
  // online time across phase boundaries; each cycle belongs to the phase it
  // started in.
  bench.begin(phases[0][0]);
  const probing = cycles(bench, probes, total, 1);
  const reports = [];
  for (const [index, [name, ms]] of phases.entries()) {
    if (index) {
      // Not awaited, so the next phase starts on time while this one resolves.
      reports.push(bench.end());
      bench.begin(name);
    }
    if (name === 'redis-outage') await docker('kill', container);
    if (name === 'redis-recovery') await docker('start', container);
    await delay(ms);
  }
  await probing;
  reports.push(bench.end());
  return Promise.all(reports);
}

export async function capacity(bench, { stages = [2000, 4000, 8000, 12000, 15000] } = {}) {
  const windows = [];
  for (const size of stages) {
    // The ramp is its own window, so watch refusals during admission count.
    bench.begin(`ramp-${size}`);
    await start(bench, size, 3 * MINUTE, { required: false });
    const ramp = await bench.end({ target: size });
    const report = await bench.measure(`capacity-${size}`, 2 * MINUTE, { target: size });
    const refused = errors(ramp) + errors(report);
    report.passed = report.sockets.open >= 0.99 * size && report.sockets.ready >= 0.99 * size && refused <= 0.01 * size;
    report.refused = refused;
    windows.push(ramp, report);
    if (!report.passed) break;
  }
  return windows;
}

// Each scenario with the number of users it may connect, whose tickets are
// fetched before it starts.
export const SCENARIOS = {
  smoke: { run: smoke, users: 64 },
  idle: { run: idle, users: 3500 },
  churn: { run: churn, users: 1600 },
  'gateway-kill': { run: gatewayKill, users: 1600 },
  'redis-kill': { run: redisKill, users: 1600 },
  capacity: { run: capacity, users: 15000 },
};
