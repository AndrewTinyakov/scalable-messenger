// One benchmark device: a WebSocket that watches presence the way each build's
// browser client does, and reports every status it learns.
import WebSocket from 'ws';

// How the browser clients watch. Legacy renews its sidebar watch every 20-23 s
// and its open-chat watch every 12-15 s. Current sends its watch set once per
// connection and, like its client, spaces watch commands one second apart.
// The watch sets themselves are the seeded ones (see plan.mjs), not the
// browser's rendered rows.
const adapters = {
  legacy: {
    watch(client) {
      const { directChats, group, groupMembers } = client.watch;
      const sidebar = () => client.send({ type: 'watch_sidebar', version: 1, chatIds: [...directChats].sort() });
      sidebar();
      client.every(20_000, 3_000, sidebar);
      if (group) {
        const userIds = groupMembers.map(member => client.plan.users[member].id);
        const open = () => client.send({ type: 'watch_presence', version: 1, chatId: group.id, userIds });
        open();
        client.every(12_000, 3_000, open);
      }
    },
    statuses(frame) {
      if (frame.type !== 'sidebar_presence' && frame.type !== 'presence') return null;
      return frame.statuses.map(status => [status.userId, { online: true, offline: false }[status.state]]);
    },
  },
  current: {
    watch(client) {
      const { subjects, group } = client.watch;
      client.send({ type: 'watch_presence', version: 1, reset: true, add: subjects.map(subject => client.plan.users[subject].id) });
      if (group) client.after(1000, () => client.send({ type: 'watch_online_count', version: 1, chatId: group.id }));
    },
    statuses(frame) {
      if (frame.type !== 'presence') return null;
      return [
        ...frame.statuses.map(status => [status.userId, status.online]),
        ...(frame.unavailable ?? []).map(id => [id, undefined]),
      ];
    },
  },
};

export class Client {
  socket = null;
  open = false;
  // subject index -> last known online state.
  known = new Map();
  readyAt = null;
  countPending = false;
  countSeen = false;
  timers = new Set();

  constructor({ index, plan, watch, protocol, url, origin, ticket, hub }) {
    Object.assign(this, { index, plan, watch, url, origin, ticket, hub, adapter: adapters[protocol] });
    this.expected = new Set(watch.subjects);
  }

  // Ready while open with a known state for every watched user and, for a
  // current client with its group open, a received online count.
  get ready() {
    return this.open && this.known.size === this.expected.size && (!this.countPending || this.countSeen);
  }

  connect() {
    const socket = new WebSocket(this.url, ['messenger', `messenger-ticket.${this.ticket()}`], {
      headers: { Origin: this.origin }, perMessageDeflate: false, maxPayload: 1 << 20, handshakeTimeout: 15_000,
    });
    this.socket = socket;
    this.known.clear();
    this.readyAt = null;
    this.countPending = this.adapter === adapters.current && Boolean(this.watch.group);
    this.countSeen = false;
    this.closing = false;
    const started = performance.now();
    return new Promise(resolve => {
      socket.once('open', () => {
        this.open = true;
        this.openedAt = performance.now();
        this.hub.opened(this, this.openedAt - started);
        this.adapter.watch(this);
        resolve(true);
      });
      socket.on('message', data => this.receive(data));
      socket.on('error', error => this.hub.socketError(this, error));
      socket.once('close', code => {
        const wasOpen = this.open;
        this.open = false;
        this.clearTimers();
        if (this.socket === socket) this.socket = null;
        this.hub.closed(this, code, this.closing, wasOpen);
        resolve(false);
      });
    });
  }

  close(code = 1000) {
    if (!this.socket) return Promise.resolve();
    const socket = this.socket;
    this.closing = true;
    return new Promise(resolve => {
      socket.once('close', () => resolve());
      socket.close(code);
    });
  }

  terminate() {
    this.closing = true;
    this.socket?.terminate();
  }

  setActive(active) {
    this.send({ type: 'activity', version: 1, active, visible: active });
  }

  send(frame) {
    if (this.open) this.socket.send(JSON.stringify(frame));
  }

  after(ms, action) {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  every(base, jitter, action) {
    const timer = setInterval(action, base + Math.random() * jitter);
    timer.unref();
    this.timers.add(timer);
  }

  clearTimers() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  receive(data) {
    const now = performance.now();
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      this.hub.count('frames.invalidJson');
      return;
    }
    this.hub.frame(this, frame, data.length);
    if (frame.type === 'online_count') this.countSeen = true;
    for (const [userId, online] of this.adapter.statuses(frame) ?? []) {
      const subject = this.hub.userIndex(userId);
      if (subject === undefined || !this.expected.has(subject)) {
        // A state for a user outside the watch set would leak presence; an
        // "unavailable" answer for one is the expected denial.
        this.hub.count(online === undefined ? 'presence.denied' : 'presence.unexpectedSubject');
        continue;
      }
      this.hub.count('presence.statuses');
      if (online === undefined) {
        this.known.delete(subject);
        continue;
      }
      const prior = this.known.get(subject);
      if (prior === online) continue;
      this.known.set(subject, online);
      this.hub.status(this, subject, online, prior, now);
    }
    if (this.readyAt === null && this.ready) {
      this.readyAt = now;
      this.hub.ready(this, now - this.openedAt);
    }
  }
}
