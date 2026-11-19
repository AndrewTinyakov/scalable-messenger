import { setTimeout as delay } from 'node:timers/promises';
import { TicketAdmission } from '../features-load/tickets.mjs';
import { Histogram } from '../features-load/metrics.mjs';

export class Fault extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export class Measurements {
  counts = Object.create(null);
  statuses = Object.create(null);
  latencies = new Map();
  failures = Object.create(null);
  rss = 0;

  count(name, amount = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + amount;
  }

  observe(name, ms) {
    if (!this.latencies.has(name)) this.latencies.set(name, new Histogram());
    this.latencies.get(name).observe(Math.max(0, ms));
  }

  failure(operation, error) {
    const key = operation + '/' + (error instanceof Fault ? error.code : 'unexpected');
    this.failures[key] = (this.failures[key] ?? 0) + 1;
  }

  report() {
    return {
      counts: this.counts, httpStatuses: this.statuses, failures: this.failures,
      generatorRssBytes: this.rss,
      latencies: Object.fromEntries([...this.latencies].map(([name, histogram]) => [name, histogram.report()])),
    };
  }
}

export const isId = value => typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
export const isSeq = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value);
export const greater = (a, b) => BigInt(a) > BigInt(b);

export function check(condition, code = 'invalidResponse') {
  if (!condition) throw new Fault(code);
}

export function query(path, parameters) {
  return path + '?' + new URLSearchParams(parameters);
}

const sleepForAdmission = (ms, signal) => delay(Math.max(0, ms), undefined, { signal });

export class Http {
  controller = new AbortController();
  inflight = 0;

  constructor(options, metrics) {
    this.options = options;
    this.metrics = metrics;
    this.tickets = new TicketAdmission({ intervalMs: Math.ceil(1000 / options.ticketRate), limit: 64, sleep: sleepForAdmission });
    this.auth = new TicketAdmission({ intervalMs: Math.ceil(1000 / options.authRate), limit: 32, sleep: sleepForAdmission });
  }

  async request(session, path, method = 'GET', body) {
    const signal = this.controller.signal;
    const ticket = path === '/auth/ws-ticket';
    const auth = path === '/auth/login' || path === '/auth/register';
    const retries = auth ? 0 : method === 'GET' || path.endsWith('/deletions') ? 3 : 0;
    for (let attempt = 0; ; attempt++) {
      if (ticket || auth) {
        const started = performance.now();
        await (ticket ? this.tickets : this.auth).acquire(signal);
        if (ticket) this.metrics.observe('ticket.admission', performance.now() - started);
      }
      try {
        return await this.attempt(session, path, method, body, signal);
      } catch (error) {
        const transient = error instanceof Fault && /^(http(429|500|502|503|504)|network)$/.test(error.code);
        const allowed = !auth && error.code === 'http429' ? 3 : retries;
        if (!transient || attempt >= allowed) throw error;
        await delay(Math.min(30000, Math.max(500 * 2 ** attempt, error.retryAfter ?? 0)), undefined, { signal });
      }
    }
  }

  async attempt(session, path, method, body, signal) {
    check(this.inflight < 256, 'httpCapacity');
    this.inflight++;
    try {
      const token = session?.cookie;
      const identified = session?.userId && path !== '/auth/session' && !/^\/auth\/(login|register)$/.test(path);
      const response = await fetch(this.options.api + '/v1' + path, {
        method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        headers: {
          ...(token ? { cookie: token } : {}),
          ...(identified ? { 'x-messenger-user': session.userId, 'x-messenger-device': session.deviceId } : {}),
          ...(method !== 'GET' ? { origin: this.options.origin, 'x-messenger-csrf': '1' } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const status = response.status;
      this.metrics.statuses[status] = (this.metrics.statuses[status] ?? 0) + 1;
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Fault('http' + status);
        const retry = response.headers.get('retry-after');
        if (retry) error.retryAfter = /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        throw error;
      }
      if (path === '/auth/login' || path === '/auth/register') {
        const cookie = response.headers.getSetCookie().find(value => /^(?:__Host-)?messenger_session=/.test(value));
        check(cookie, 'missingCookie');
        session.cookie = cookie.split(';', 1)[0];
      }
      if (status === 204) return null;
      const reader = response.body?.getReader();
      check(reader);
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 ** 20) {
          await reader.cancel();
          throw new Fault('responseLimit');
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof Fault || signal.aborted) throw error;
      throw new Fault(error instanceof SyntaxError ? 'invalidJson' : 'network');
    } finally {
      this.inflight--;
    }
  }
}

const chatEvents = new Set([
  'message_saved', 'message_changed', 'reads_changed', 'history_changed', 'chat_preferences_changed',
  'pins_changed', 'sidebar_activity', 'subscribed', 'presence', 'chat_created', 'membership_changed',
  'member_removed', 'recovery_failed', 'subscription_expired', 'chat_deleted',
]);
const knownEvents = new Set([...chatEvents, 'queued', 'send_rejected', 'error', 'sidebar_presence', 'session_revoked']);

export class Socket {
  closed = false;

  constructor(http, credentials, receive) {
    Object.assign(this, { http, credentials, receive });
  }

  async open() {
    const ticket = await this.http.request(this.credentials, '/auth/ws-ticket', 'POST');
    check(typeof ticket?.token === 'string' && ticket.token.length <= 4096);
    check(!this.closed, 'socketClosed');
    const ws = new WebSocket(this.http.options.ws, {
      protocols: ['messenger', `messenger-ticket.${ticket.token}`],
      headers: { Origin: this.http.options.origin },
    });
    this.ws = ws;
    ws.addEventListener('message', ({ data }) => {
      try {
        check(typeof data === 'string' && Buffer.byteLength(data) <= 65536, 'frameLimit');
        const frame = JSON.parse(data);
        check(frame.version === 1 && knownEvents.has(frame.type), 'frameType');
        if (chatEvents.has(frame.type)) check(isId(frame.chatId), 'frameChat');
        if (frame.type === 'message_saved' || frame.type === 'message_changed') {
          check(isId(frame.messageId) && isId(frame.senderId) && isSeq(frame.sequence) && isSeq(frame.messageVersion), 'frameMessage');
        }
        if (frame.requestId !== undefined && frame.requestId !== null) check(isId(frame.requestId), 'frameRequest');
        this.receive(frame);
      } catch (error) {
        this.http.metrics.failure('socket.decode', error);
      }
    });
    ws.addEventListener('close', () => {
      if (!this.closed && this.opened) this.http.metrics.failure('socket.close', new Fault('unexpectedClose'));
    });
    await new Promise((resolve, reject) => {
      const abort = () => done(new Fault('socketAborted'));
      const cleanup = () => {
        clearTimeout(timer);
        this.http.controller.signal.removeEventListener('abort', abort);
      };
      const done = error => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => done(new Fault('upgradeTimeout')), 15000);
      this.http.controller.signal.addEventListener('abort', abort, { once: true });
      ws.addEventListener('open', () => done(), { once: true });
      ws.addEventListener('error', () => done(new Fault('upgradeFailed')), { once: true });
      ws.addEventListener('close', () => done(new Fault('upgradeClosed')), { once: true });
    });
    this.opened = true;
  }

  send(frame) {
    check(this.ws?.readyState === WebSocket.OPEN, 'socketUnavailable');
    const payload = JSON.stringify({ version: 1, ...frame });
    check(this.ws.bufferedAmount + Buffer.byteLength(payload) <= 65536, 'writerCapacity');
    this.ws.send(payload);
  }

  async close() {
    this.closed = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2000);
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.close();
    });
  }
}
