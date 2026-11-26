// Scenario runner: holds the clients, paces connections, injects faults and
// measures each window from both sides.
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Histogram } from '../features-load/metrics.mjs';
import { Client } from './client.mjs';
import { watchSet } from './plan.mjs';
import { collect } from './prometheus.mjs';

const run = promisify(execFile);
const RATE_WINDOW_MS = 30_000;

class Window {
  constructor(name, counts) {
    this.name = name;
    this.startedAt = Date.now();
    this.started = performance.now();
    this.baseline = { ...counts };
    this.latency = new Map();
    const outcomes = () => ({ armed: 0, delivered: 0, missing: 0, superseded: 0, watcherClosed: 0 });
    this.changes = { online: outcomes(), offline: outcomes() };
  }

  observe(name, ms) {
    if (!this.latency.has(name)) this.latency.set(name, new Histogram());
    this.latency.get(name).observe(ms);
  }
}

export class Bench {
  clients = new Map();
  counts = Object.create(null);
  // subject -> pending change { online, at, window, waiting: Set<watcher> }
  pending = new Map();
  held = new Set();
  autoReconnect = true;
  window = null;
  windows = [];

  constructor({ plan, protocol, url, origin, tickets, prometheus, deadlineMs = 15_000, connectRate = 100, log = console.error }) {
    Object.assign(this, { plan, protocol, url, origin, tickets, prometheus, deadlineMs, connectRate, log });
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
    this.onClose?.(client, expected, wasOpen);
    for (const [actor, change] of this.pending) {
      if (!change.waiting.delete(client.index)) continue;
      change.outcomes.watcherClosed++;
      if (!change.waiting.size) this.pending.delete(actor);
    }
    if (!expected && wasOpen && this.autoReconnect && !this.held.has(client.index)) {
      // Browsers reconnect after a short random backoff.
      setTimeout(() => this.reconnect(client), 1000 + Math.random() * 4000).unref();
    }
  }

  async reconnect(client) {
    if (client.socket || this.held.has(client.index)) return;
    this.count('socket.reconnects');
    if (!await client.connect()) this.count('socket.reconnectFailed');
  }

  status(client, subject, online, prior, now) {
    if (prior !== undefined) this.count('presence.transitions');
    const change = this.pending.get(subject);
    if (!change || change.online !== online || !change.waiting.delete(client.index)) return;
    change.outcomes.delivered++;
    if (!change.waiting.size) this.pending.delete(subject);
    change.window.observe(online ? 'delivery.online' : 'delivery.offline', now - change.at);
  }

  // Connections.

  client(user) {
    let client = this.clients.get(user);
    if (!client) {
      client = new Client({
        index: user, plan: this.plan, watch: this.watches[user], protocol: this.protocol, url: this.url, origin: this.origin,
        ticket: () => this.tickets.get(user).token, hub: this,
      });
      this.clients.set(user, client);
    }
    return client;
  }

  get open() { return [...this.clients.values()].filter(client => client.open); }

  // Opens the users' sockets at the configured rate, at most 64 handshakes at a time.
  async connect(users, rate = this.connectRate) {
    const interval = 1000 / rate;
    let next = performance.now();
    const inflight = new Set();
    for (const user of users) {
      const client = this.client(user);
      if (client.socket) continue;
      while (inflight.size >= 64) await Promise.race(inflight);
      const wait = next - performance.now();
      if (wait > 0) await delay(wait);
      next = Math.max(next + interval, performance.now());
      const attempt = this.connectWithRetry(client).finally(() => inflight.delete(attempt));
      inflight.add(attempt);
    }
    await Promise.all(inflight);
  }

  async connectWithRetry(client) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) {
        this.count('socket.connectRetries');
        await delay(1000 * 2 ** attempt);
      }
      if (await client.connect()) return true;
    }
    return false;
  }

  async disconnect(users) {
    await Promise.all(users.map(user => this.clients.get(user)?.close()));
  }

  // Waits until every open socket knows all of its subjects, or the timeout passes.
  async settle(ms) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
      if (this.open.every(client => client.ready)) return true;
      await delay(500);
    }
    return false;
  }

  // Changes whose delivery is measured.

  // Records that `actor` becomes online/offline at `at`; every open watcher that
  // currently knows the opposite state must report the new one in time.
  expect(actor, online, at = performance.now(), deadlineMs = this.deadlineMs) {
    const window = this.window;
    const previous = this.pending.get(actor);
    if (previous) this.finish(actor, previous, 'superseded');
    const waiting = new Set();
    for (const watcher of this.watchers[actor]) {
      const client = this.clients.get(watcher);
      if (client?.open && client.known.get(actor) === !online) waiting.add(watcher);
    }
    if (!window || !waiting.size) return;
    const outcomes = window.changes[online ? 'online' : 'offline'];
    outcomes.armed += waiting.size;
    const change = { online, at, window, outcomes, waiting };
    this.pending.set(actor, change);
    setTimeout(() => this.finish(actor, change), deadlineMs).unref();
  }

  finish(actor, change, outcome = 'missing') {
    if (this.pending.get(actor) !== change) return;
    this.pending.delete(actor);
    change.outcomes[outcome] += change.waiting.size;
  }

  // Closes the actor, keeps it offline for `offlineMs`, then reconnects it.
  async cycle(actor, offlineMs) {
    const client = this.client(actor);
    if (!client.open) return;
    this.held.add(actor);
    this.expect(actor, false);
    await client.close();
    await delay(offlineMs);
    this.held.delete(actor);
    this.expect(actor, true);
    await this.connectWithRetry(client);
  }

  async toggleActivity(actor, active) {
    const client = this.client(actor);
    if (!client.open) return;
    this.expect(actor, active);
    client.setActive(active);
  }

  // Runs `action` for actors spread evenly over `ms` at `perSecond`.
  async pace(ms, perSecond, actors, action) {
    const until = performance.now() + ms;
    const tasks = [];
    for (let i = 0; performance.now() < until; i++) {
      tasks.push(action(actors[i % actors.length]).catch(error => this.count('action.failed.' + (error.code ?? 'other'))));
      await delay(1000 / perSecond);
    }
    await Promise.all(tasks);
  }

  // Windows.

  begin(name) {
    this.loop.reset();
    this.window = new Window(name, this.counts);
    return this.window;
  }

  async end(extra = {}) {
    const window = this.window;
    this.window = null;
    const endedAt = Date.now();
    const durationMs = performance.now() - window.started;
    const loop = { eventLoopP99Ms: this.loop.percentile(99) / 1e6, eventLoopMaxMs: this.loop.max / 1e6 };
    const open = this.open;
    const expected = open.reduce((sum, client) => sum + client.expected.size, 0);
    const known = open.reduce((sum, client) => sum + client.known.size, 0);
    const counts = Object.fromEntries(Object.entries(this.counts)
      .map(([name, value]) => [name, value - (window.baseline[name] ?? 0)]).filter(([, value]) => value));
    // Changes armed near the end resolve (or expire) before they are reported.
    while ([...this.pending.values()].some(change => change.window === window)) await delay(250);
    const report = {
      name: window.name, startedAt: window.startedAt, endedAt, durationMs: Math.round(durationMs),
      sockets: { open: open.length, ready: open.filter(client => client.ready).length },
      watchEdges: { expected, known, coverage: expected ? known / expected : null },
      perSecond: {
        frames: (counts.frames ?? 0) * 1000 / durationMs,
        bytes: (counts.bytes ?? 0) * 1000 / durationMs,
        statuses: (counts['presence.statuses'] ?? 0) * 1000 / durationMs,
      },
      counts,
      changes: window.changes,
      latencyMs: Object.fromEntries([...window.latency].map(([name, histogram]) => [name, histogram.report()])),
      generator: { ...loop, rssMiB: process.memoryUsage().rss / 2 ** 20 },
      ...extra,
    };
    report.generator.limited = report.generator.eventLoopP99Ms > 50;
    try {
      // Rates use a 30 s lookback, so the first 30 s still reflect the previous phase.
      const from = endedAt - window.startedAt > 2 * RATE_WINDOW_MS ? window.startedAt + RATE_WINDOW_MS : window.startedAt;
      report.server = await collect(this.prometheus, from, endedAt);
    } catch (error) {
      report.server = { error: error.message };
    }
    this.windows.push(report);
    this.log(summary(report));
    return report;
  }

  async measure(name, ms, during = () => delay(ms), extra) {
    this.begin(name);
    await during();
    return this.end(extra);
  }

  close() {
    this.autoReconnect = false;
    for (const client of this.clients.values()) client.terminate();
    this.loop.disable();
  }
}

function summary(report) {
  const delivery = ['delivery.online', 'delivery.offline'].map(name => {
    const latency = report.latencyMs[name];
    return latency ? `${name.split('.')[1]} p50/p99 ${latency.p50UpperMs.toFixed(0)}/${latency.p99UpperMs.toFixed(0)} ms` : null;
  }).filter(Boolean).join(', ');
  const server = report.server && !report.server.error
    ? ` | gw ${report.server.gatewayCpuCores?.mean?.toFixed(3)} cores, redis ${report.server.redisCommandsPerSec?.mean?.toFixed(0)} cmd/s, api ${report.server.apiGrpcPerSec?.mean?.toFixed(1)} rpc/s`
    : '';
  const changes = ['online', 'offline'].map(direction => {
    const { delivered, armed, missing } = report.changes[direction];
    return `${direction} ${delivered}/${armed}${missing ? ` (${missing} missing)` : ''}`;
  }).join(', ');
  return `[${report.name}] sockets ${report.sockets.ready}/${report.sockets.open} ready, coverage ${(report.watchEdges.coverage ?? 0).toFixed(4)}, ` +
    `${report.perSecond.frames.toFixed(1)} frames/s, delivered ${changes}; ${delivery}${server}`;
}

export async function docker(...args) {
  const { stdout } = await run('docker', args);
  return stdout.trim();
}

export async function waitHealthy(container, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const status = await docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', container);
    if (status === 'healthy' || status === 'running') return;
    await delay(1000);
  }
  throw new Error(`${container} did not become healthy`);
}
