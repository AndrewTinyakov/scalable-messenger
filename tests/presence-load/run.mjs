// Scenario runner: holds the clients, keeps the intended sockets connected,
// injects changes and measures each window from both sides.
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Histogram } from '../features-load/metrics.mjs';
import { Client } from './client.mjs';
import { watchSet } from './plan.mjs';
import { collect } from './prometheus.mjs';

const run = promisify(execFile);
// A change that misses its deadline stays tracked this much longer, so a late
// delivery is counted as late rather than missing.
const LATE_GRACE_MS = 45_000;
const MAX_BACKOFF_MS = 30_000;

class Window {
  constructor(name, counts) {
    this.name = name;
    this.startedAt = Date.now();
    this.started = performance.now();
    this.baseline = { ...counts };
    this.latency = new Map();
    this.changes = {};
    this.tasks = new Set();
    this.schedules = [];
  }

  observe(name, ms) {
    if (!this.latency.has(name)) this.latency.set(name, new Histogram());
    this.latency.get(name).observe(ms);
  }

  // Outcomes per watcher for one kind of change, e.g. "offline" or "hot.online".
  outcomes(kind) {
    this.changes[kind] ??= { armed: 0, delivered: 0, late: 0, missing: 0, superseded: 0, watcherClosed: 0, alreadyShown: 0 };
    return this.changes[kind];
  }
}

export class Bench {
  clients = new Map();
  counts = Object.create(null);
  // actor -> the change its watchers are expected to report.
  pending = new Map();
  // Users whose sockets should be open, and those among them kept offline for now.
  live = new Set();
  held = new Set();
  reconnecting = new Set();
  pauseReconnects = false;
  stopped = false;
  window = null;

  constructor({ plan, protocol, url, origin, ticket, prometheus, deadlineMs = 15_000, connectRate = 100, log = console.error }) {
    Object.assign(this, { plan, protocol, url, origin, ticket, prometheus, deadlineMs, connectRate, log });
    this.ids = new Map(plan.users.map((user, index) => [user.id, index]));
    this.watchers = plan.users.map(() => []);
    this.watches = plan.users.map((_, user) => watchSet(plan, user));
    for (const [user, watch] of this.watches.entries()) {
      for (const subject of watch.subjects) this.watchers[subject].push(user);
    }
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
  }

  // Hub callbacks from clients.

  count(name, amount = 1) { this.counts[name] = (this.counts[name] ?? 0) + amount; }
  userIndex(id) { return this.ids.get(id); }

  opened(client, ms) {
    this.count('socket.opened');
    this.window?.observe('connect', ms);
  }

  ready(client, ms) {
    this.count('watch.ready');
    this.window?.observe('watchReady', ms);
  }

  frame(client, frame, bytes) {
    this.count('frames');
    this.count('bytes', bytes);
    this.count('frames.' + frame.type);
    if (frame.type === 'error') this.count('errors.' + frame.code);
  }

  socketError(client, error) {
    this.count('socket.error.' + (error.message.match(/Unexpected server response: (\d+)/)?.[1] ?? error.code ?? 'other'));
  }

  closed(client, code, expected, wasOpen) {
    this.count(expected ? 'socket.closed' : wasOpen ? 'socket.unexpectedClose.' + code : 'socket.connectFailed');
    const now = performance.now();
    for (const [actor, change] of this.pending) {
      if (!change.waiting.delete(client.index)) continue;
      change.outcomes[now <= change.deadline ? 'watcherClosed' : 'missing']++;
      if (!change.waiting.size) this.pending.delete(actor);
    }
    // Browsers reconnect after a short random backoff.
    if (!expected) this.keep(client, 1000 + Math.random() * 4000);
  }

  status(client, subject, online, prior, now) {
    if (prior !== undefined) this.count('presence.transitions');
    const change = this.pending.get(subject);
    if (!change || change.online !== online || !change.waiting.delete(client.index)) return;
    if (now <= change.deadline) {
      change.outcomes.delivered++;
      change.window.observe('delivery.' + change.kind, now - change.at);
    } else {
      change.outcomes.late++;
    }
    if (!change.waiting.size) this.pending.delete(subject);
  }

  // Connections.

  client(user) {
    let client = this.clients.get(user);
    if (!client) {
      client = new Client({
        index: user, plan: this.plan, watch: this.watches[user], protocol: this.protocol, url: this.url, origin: this.origin,
        ticket: () => this.ticket(user), hub: this,
      });
      this.clients.set(user, client);
    }
    return client;
  }

  get open() { return [...this.clients.values()].filter(client => client.open); }

  // Users meant to be connected right now.
  get intended() { return [...this.live].filter(user => !this.held.has(user)); }

  wanted(client) {
    return !this.stopped && this.live.has(client.index) && !this.held.has(client.index) && !client.socket;
  }

  // Reconnects an intended-live socket with capped exponential backoff until it
  // opens, it is no longer wanted, or the run ends.
  async keep(client, firstDelayMs = 1000) {
    if (this.reconnecting.has(client)) return;
    this.reconnecting.add(client);
    try {
      for (let attempt = 0, wait = firstDelayMs; ; attempt++, wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt)) {
        await delay(wait * (0.5 + Math.random()));
        while (this.pauseReconnects && !this.stopped) await delay(500);
        if (!this.wanted(client)) return;
        this.count('socket.reconnects');
        if (await client.connect()) return;
      }
    } finally {
      this.reconnecting.delete(client);
    }
  }

  // Opens the users' sockets at `rate`, at most 64 handshakes at a time. A
  // failed first attempt is retried in the background. `beforeAttempt` runs
  // just before each socket's first attempt.
  async connect(users, rate = this.connectRate, beforeAttempt) {
    const interval = 1000 / rate;
    let next = performance.now();
    const inflight = new Set();
    for (const user of users) {
      this.live.add(user);
      while (inflight.size >= 64) await Promise.race(inflight);
      const wait = next - performance.now();
      if (wait > 0) await delay(wait);
      // A background retry may have connected the socket while this one waited.
      const client = this.client(user);
      if (client.socket) continue;
      next = Math.max(next + interval, performance.now());
      beforeAttempt?.(user);
      const attempt = client.connect().then(opened => { if (!opened) this.keep(client); })
        .finally(() => inflight.delete(attempt));
      inflight.add(attempt);
    }
    await Promise.all(inflight);
  }

  // Waits until every given user (by default every intended one) has a ready
  // socket, or the timeout passes.
  async settle(ms, users) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if ((users ?? this.intended).every(user => this.clients.get(user)?.ready)) return true;
      await delay(500);
    }
    return false;
  }

  // Changes whose delivery is measured.

  // `actor` became online/offline at `at`. Every open watcher must report the
  // new state by the deadline; one already showing it is counted apart. Each
  // armed watcher ends in exactly one outcome.
  expect(actor, online, { at = performance.now(), deadlineMs = this.deadlineMs, label, window = this.window } = {}) {
    const previous = this.pending.get(actor);
    if (previous) this.finish(actor, previous);
    if (!window) return;
    const kind = (label ? label + '.' : '') + (online ? 'online' : 'offline');
    const outcomes = window.outcomes(kind);
    const waiting = new Set();
    for (const watcher of this.watchers[actor]) {
      const client = this.clients.get(watcher);
      if (!client?.open) continue;
      if (client.known.get(actor) === online) outcomes.alreadyShown++;
      else waiting.add(watcher);
    }
    if (!waiting.size) return;
    outcomes.armed += waiting.size;
    const deadline = at + deadlineMs;
    const change = { online, at, deadline, kind, window, outcomes, waiting };
    this.pending.set(actor, change);
    setTimeout(() => this.finish(actor, change), Math.max(0, deadline + LATE_GRACE_MS - performance.now())).unref();
  }

  // Stops tracking a change. Watchers still waiting were superseded if the
  // deadline had not passed yet, and are missing otherwise.
  finish(actor, change) {
    if (this.pending.get(actor) !== change) return;
    this.pending.delete(actor);
    change.outcomes[performance.now() <= change.deadline ? 'superseded' : 'missing'] += change.waiting.size;
  }

  // Ends every tracked change; called once before the report is written.
  finishAll() {
    for (const [actor, change] of [...this.pending]) this.finish(actor, change);
  }

  // Closes the actor, keeps it offline for `offlineMs`, then reconnects it.
  // Both changes belong to `window`, the window the cycle started in.
  async cycle(actor, offlineMs, { label, window } = {}) {
    const client = this.client(actor);
    if (!client.open) return false;
    this.held.add(actor);
    this.expect(actor, false, { label, window });
    await client.close();
    await delay(offlineMs);
    this.held.delete(actor);
    this.expect(actor, true, { label, window });
    if (!client.socket && !await client.connect()) this.keep(client);
    return true;
  }

  // The tab stays visible: the user stops or resumes interacting.
  toggleActivity(actor, active, window) {
    const client = this.client(actor);
    if (!client.open) return false;
    this.expect(actor, active, { window });
    client.setActive(active);
    return true;
  }

  // Starts `action(actor, window)` for actors spread evenly over `ms` at
  // `perSecond`, and returns once scheduling stops. Each action belongs to the
  // window open when it started, which waits for it before reporting; an
  // action that returns false found its actor unavailable.
  async pace(ms, perSecond, actors, action) {
    const started = performance.now();
    const schedules = new Map();
    for (let i = 0; performance.now() - started < ms; i++) {
      const window = this.window;
      if (window && !schedules.has(window)) {
        const schedule = { requestedPerSecond: perSecond, scheduled: 0, skipped: 0 };
        schedules.set(window, schedule);
        window.schedules.push(schedule);
      }
      const schedule = schedules.get(window);
      if (schedule) schedule.scheduled++;
      const task = Promise.resolve(action(actors[i % actors.length], window))
        .then(ran => { if (ran === false && schedule) schedule.skipped++; })
        .catch(error => this.count('action.failed.' + (error.code ?? 'other')));
      window?.tasks.add(task);
      await delay(Math.max(0, started + (i + 1) * 1000 / perSecond - performance.now()));
    }
  }

  // Windows.

  begin(name) {
    this.loop.reset();
    this.window = new Window(name, this.counts);
    return this.window;
  }

  // Ends the window: everything is measured now, then the report waits for the
  // window's actions to finish and its changes to pass their deadlines.
  async end(extra = {}) {
    const window = this.window;
    this.window = null;
    const endedAt = Date.now();
    const durationMs = performance.now() - window.started;
    const loop = { eventLoopP99Ms: this.loop.percentile(99) / 1e6, eventLoopMaxMs: this.loop.max / 1e6 };
    const open = this.open;
    const expected = open.reduce((sum, client) => sum + client.expected.size, 0);
    const known = open.reduce((sum, client) => sum + client.known.size, 0);
    const sockets = { intended: this.intended.length, open: open.length, ready: open.filter(client => client.ready).length };
    const counts = Object.fromEntries(Object.entries(this.counts)
      .map(([name, value]) => [name, value - (window.baseline[name] ?? 0)]).filter(([, value]) => value));
    for (const schedule of window.schedules) schedule.offeredPerSecond = schedule.scheduled * 1000 / durationMs;
    await Promise.all(window.tasks);
    const due = () => [...this.pending.values()].some(change => change.window === window && performance.now() <= change.deadline);
    while (due()) await delay(250);
    const report = {
      name: window.name, startedAt: window.startedAt, endedAt, durationMs: Math.round(durationMs),
      sockets, watchEdges: { expected, known, coverage: expected ? known / expected : null },
      perSecond: {
        frames: (counts.frames ?? 0) * 1000 / durationMs,
        bytes: (counts.bytes ?? 0) * 1000 / durationMs,
        statuses: (counts['presence.statuses'] ?? 0) * 1000 / durationMs,
      },
      counts,
      schedules: window.schedules,
      // Late deliveries and finishAll() complete this object before the report is written.
      changes: window.changes,
      latencyMs: Object.fromEntries([...window.latency].map(([name, histogram]) => [name, histogram.report()])),
      generator: { ...loop, rssMiB: process.memoryUsage().rss / 2 ** 20, limited: loop.eventLoopP99Ms > 50 },
      ...extra,
    };
    try {
      report.server = await collect(this.prometheus, window.startedAt, endedAt);
    } catch (error) {
      report.server = { error: error.message };
    }
    this.log(summary(report));
    return report;
  }

  async measure(name, ms, during = () => delay(ms), extra) {
    this.begin(name);
    await during();
    return this.end(extra);
  }

  close() {
    this.stopped = true;
    for (const client of this.clients.values()) client.terminate();
    this.loop.disable();
  }
}

function summary(report) {
  const changes = Object.entries(report.changes).map(([kind, { delivered, armed, late, missing }]) => {
    const latency = report.latencyMs['delivery.' + kind];
    return `${kind} ${delivered}/${armed}${late ? ` (${late} late)` : ''}${missing ? ` (${missing} missing)` : ''}` +
      (latency ? ` p50/p99 ${latency.p50UpperMs.toFixed(0)}/${latency.p99UpperMs.toFixed(0)} ms` : '');
  }).join(', ');
  const mean = (name, digits) => report.server?.[name]?.mean?.toFixed(digits) ?? '-';
  const server = report.server && !report.server.error
    ? ` | gw ${mean('gatewayCpuCores', 3)} cores, redis ${mean('redisCommandsPerSec', 0)} cmd/s, api ${mean('apiGrpcPerSec', 1)} rpc/s`
    : '';
  return `[${report.name}] sockets ${report.sockets.ready}/${report.sockets.intended} ready, coverage ${(report.watchEdges.coverage ?? 0).toFixed(4)}, ` +
    `${report.perSecond.frames.toFixed(1)} frames/s${changes ? `, ${changes}` : ''}${server}`;
}

export async function docker(...args) {
  const { stdout } = await run('docker', args);
  return stdout.trim();
}

export async function waitHealthy(container, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container);
    if (status === 'healthy') return;
    await delay(1000);
  }
  throw new Error(`${container} did not become healthy`);
}
