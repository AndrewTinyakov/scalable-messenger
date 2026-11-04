import { readFile, open, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ticketAdmission } from './tickets.mjs';

export class Http {
  constructor(options, metrics) { this.options = options; this.metrics = metrics; this.measuring = false; this.inflight = 0; this.peak = 0; this.controller = new AbortController(); }
  async request(session, path, { method = 'GET', body, operation = 'setup', expect = [200, 201, 204] } = {}) {
    const started = performance.now();
    if (path === '/auth/ws-ticket') {
      await ticketAdmission.acquire(this.controller.signal);
      this.metrics.count(`ticketAdmission.started.${this.measuring ? 'measure' : 'setup'}`);
      if (this.measuring) this.metrics.observe('ticketAdmission.wait', performance.now() - started);
    }
    this.inflight++;
    this.peak = Math.max(this.peak, this.inflight);
    if (this.measuring) this.metrics.count(`${operation}.attempted`);
    try {
      const response = await fetch(`${this.options.api}/v1${path}`, {
        method, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        headers: { cookie: session.cookie, ...(method === 'GET' ? {} : { origin: this.options.origin, 'x-messenger-csrf': '1' }), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (path === '/auth/ws-ticket' && response.status === 429) this.metrics.count(`ticket.rateLimited.${this.measuring ? 'measure' : 'setup'}`);
      const chunks = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2 ** 20) { await reader.cancel(); throw new Error('HTTP response exceeds 1 MiB'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!expect.includes(response.status)) throw new Error(`${method} ${path.split('?')[0]} returned ${response.status}: ${raw.slice(0, 120)}`);
      if (this.measuring) this.metrics.count(`${operation}.succeeded`);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (this.measuring) this.metrics.failure(`${operation}.failed`, error);
      throw error;
    } finally {
      this.inflight--;
      if (this.measuring) this.metrics.observe(operation, performance.now() - started);
    }
  }
}

export async function readPrivate(path) {
  const info = await stat(path);
  if (info.size > 8 * 2 ** 20) throw new Error('Manifest exceeds 8 MiB');
  if ((info.mode & 0o077) !== 0) throw new Error('Session/topology files must have mode 0600');
  return JSON.parse(await readFile(path, 'utf8'));
}

export function privateOutputPath(path) {
  const target = resolve(path);
  const repo = resolve(import.meta.dirname, '../..');
  const location = relative(repo, target);
  if (location !== '..' && !location.startsWith('../')) throw new Error('Private outputs must be outside the repository');
  return target;
}

export async function writePrivate(path, value) {
  const target = privateOutputPath(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); } finally { await file.close(); }
  await rename(temporary, target);
}
