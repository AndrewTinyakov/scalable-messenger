import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export class TicketAdmission {
  constructor({ intervalMs = 250, limit = 32, now = () => performance.now(), sleep = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
    Object.assign(this, { intervalMs, limit, now, sleep });
    this.queue = [];
    this.active = null;
    this.running = null;
    this.nextAt = 0;
    this.admitted = 0;
    this.cancelled = 0;
    this.rejected = 0;
    this.peakPending = 0;
  }
  acquire(signal) {
    if (signal?.aborted) { this.cancelled++; return Promise.reject(signal.reason); }
    if (this.pending >= this.limit) { this.rejected++; return Promise.reject(new Error('Ticket admission queue limit exceeded')); }
    return new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: null };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.cancelled++;
        signal.removeEventListener('abort', entry.abort);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.peakPending = Math.max(this.peakPending, this.pending);
      this.start();
    });
  }
  get pending() { return this.queue.length + (this.active ? 1 : 0); }
  start() {
    if (this.running) return;
    this.running = Promise.resolve().then(async () => {
      while (this.queue.length) {
        const entry = this.queue.shift();
        this.active = entry;
        try {
          entry.signal?.throwIfAborted();
          while (this.now() < this.nextAt) await this.sleep(this.nextAt - this.now(), entry.signal);
          entry.signal?.throwIfAborted();
          this.nextAt = this.now() + this.intervalMs;
          this.admitted++;
          entry.resolve();
        } catch (error) {
          if (entry.signal?.aborted) this.cancelled++;
          entry.reject(entry.signal?.aborted ? entry.signal.reason : error);
        } finally {
          entry.signal?.removeEventListener('abort', entry.abort);
          this.active = null;
        }
      }
    }).finally(() => {
      this.running = null;
      if (this.queue.length) this.start();
    });
  }
  async join() { while (this.running) await this.running; }
  report() { return { scope: 'processLifetimeIncludingSetup', intervalMs: this.intervalMs, maximumRequestsPerSecond: 1000 / this.intervalMs, queueLimit: this.limit, pending: this.pending, peakPending: this.peakPending, admitted: this.admitted, cancelled: this.cancelled, rejected: this.rejected }; }
}

export const ticketAdmission = new TicketAdmission();
