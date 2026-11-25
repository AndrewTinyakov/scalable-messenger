import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from '../support/fixtures.mjs';
import { chatPath, orderedMessages } from './device.mjs';
import { authenticate, workers } from './setup.mjs';
import { check, greater } from './transport.mjs';

const hash = text => typeof text === 'string' ? createHash('sha256').update(text).digest('hex') : null;
const confirmations = new Set(['send', 'forward', 'direct']);

class Verification {
  credentials = new Map();
  sessions = new Set();

  constructor(state) {
    this.state = state;
    this.http = state.verificationHttp ?? state.http;
    this.metrics = state.verificationMetrics ?? state.metrics;
  }

  sample(kind, fields) {
    if (this.state.diagnostics.filter(row => row.kind === kind).length < 20) this.state.diagnostics.push({ kind, ...fields });
  }

  async request(device, path, method = 'GET', body) {
    const actor = device.actor;
    const cacheAtStart = this.credentials.get(actor);
    let cached;
    try { cached = await cacheAtStart; } catch {}
    const candidates = [cached, device.credentials, ...(this.state.devices[actor] ?? []).map(peer => peer.credentials)];
    const tried = new Set();
    for (const candidate of candidates) {
      if (!candidate || tried.has(candidate.cookie)) continue;
      tried.add(candidate.cookie);
      const credentials = { ...candidate };
      try {
        const result = await this.http.request(credentials, path, method, body);
        if (this.credentials.get(actor) === cacheAtStart) this.credentials.set(actor, credentials);
        return result;
      } catch (error) {
        if (error.code !== 'http401') throw error;
      }
    }
    for (;;) {
      let current;
      try { current = await this.credentials.get(actor); } catch {}
      if (!current || tried.has(current.cookie)) break;
      tried.add(current.cookie);
      try {
        return await this.http.request(current, path, method, body);
      } catch (error) {
        if (error.code !== 'http401') throw error;
      }
    }
    let refreshing = this.credentials.get(actor);
    if (!refreshing || typeof refreshing.then !== 'function') {
      const replacement = { ...device.credentials, cookie: undefined, deviceId: 'verify-' + ulid() };
      refreshing = authenticate(this.http, replacement, 'login').then(() => {
        this.sessions.add(replacement);
        this.credentials.set(actor, replacement);
        return replacement;
      }).catch(error => {
        if (this.credentials.get(actor) === refreshing) this.credentials.delete(actor);
        throw error;
      });
      this.credentials.set(actor, refreshing);
    }
    return this.http.request(await refreshing, path, method, body);
  }

  async reconcile() {
    for (let pass = 0; pass < 3; pass++) {
      const pending = [...this.state.sends.values()].filter(record => !record.saved && !record.rejected);
      if (!pending.length) return;
      const devices = new Map();
      for (const record of pending) {
        if (!devices.has(record.device)) devices.set(record.device, []);
        devices.get(record.device).push(record);
      }
      await workers([...devices], 12, async ([device, records]) => {
        for (let offset = 0; offset < records.length; offset += 100) {
          const batch = records.slice(offset, offset + 100);
          try {
            const result = await this.request(device, '/sends/status', 'POST', { requestIds: batch.map(row => row.requestId) });
            check(Array.isArray(result?.results), 'invalidSendStatuses');
            for (const row of result.results) {
              const record = this.state.sends.get(row.requestId);
              if (!record || record.device !== device) continue;
              if (row.result?.status === 'SAVED') this.state.saved(record, row.result, false);
              if (row.result?.status === 'REJECTED') record.finish(null, 'rejectedByStatus');
            }
          } catch (error) {
            this.metrics.failure('verification.status', error);
            this.sample('statusUnavailable', { userId: device.credentials.userId, code: error.code ?? 'unexpected', requestIds: batch.map(row => row.requestId) });
          }
        }
      });
      if (pass < 2) await delay(250, undefined, { signal: this.state.signal });
    }
  }

  async mutation(record) {
    const mutation = this.state.mutations.get(record.saved.id);
    if (!mutation || mutation.status === 'rejected') return null;
    if (mutation.status !== 'uncertain') return mutation;
    if (mutation.kind === 'edit') return mutation;
    try {
      const status = await this.request(mutation.device, chatPath(record.saved.chatId) + '/deletions/' + mutation.requestId);
      check(status?.operationId === mutation.requestId && status.scope === mutation.kind && status.target === 'MESSAGES', 'invalidDeletionStatus');
      return { ...mutation, status: 'confirmed' };
    } catch (error) {
      if (error.code === 'http404') return null;
      throw error;
    }
  }

  matches(record, message, mutation, device) {
    const deleted = mutation?.kind === 'EVERYONE' || mutation?.kind === 'SELF' && mutation.device.actor === device.actor;
    if (deleted) return !message;
    if (!message || message.sequence !== record.saved.sequence) return false;
    if (mutation?.kind === 'edit') {
      if (message.body === mutation.body && message.messageVersion === mutation.version) return true;
      return mutation.status === 'uncertain' && message.body === record.body && message.messageVersion === mutation.before.version;
    }
    return message.body === record.body;
  }

  async run() {
    await this.reconcile();
    const records = [...this.state.sends.values()].map(record => ({ ...record, saved: record.saved && { ...record.saved }, received: new Map(record.received) }));
    const batches = new Map();
    const add = (record, device, mutation) => {
      const key = device.actor + '/' + record.saved.chatId;
      if (!batches.has(key)) batches.set(key, { device, id: record.saved.chatId, rows: [] });
      batches.get(key).rows.push({ record, mutation });
    };
    let unverified = 0;
    for (const record of records) {
      if (!record.saved) continue;
      try {
        const mutation = await this.mutation(record);
        add(record, record.device, mutation);
        if (mutation) {
          const actor = this.state.roster.get(record.saved.chatId)?.members.find(actor =>
            actor !== record.device.actor && actor % this.state.shard.count === this.state.shard.index);
          if (actor !== undefined) add(record, this.state.devices[actor][0], mutation);
        }
      } catch (error) {
        unverified++;
        this.metrics.failure('verification.mutation', error);
        this.sample('mutationUnavailable', { messageId: record.saved.id, chatId: record.saved.chatId, userId: record.device.credentials.userId, code: error.code ?? 'unexpected' });
      }
    }
    let checked = 0;
    let mismatches = 0;
    let mutationChecks = 0;
    await workers([...batches.values()], 12, async ({ device, id, rows }) => {
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        try {
          const page = await this.request(device, chatPath(id) + '/messages/resolve', 'POST', { messageIds: batch.map(row => row.record.saved.id) });
          const messages = new Map(orderedMessages(page, id, false).map(message => [message.id, message]));
          for (const { record, mutation } of batch) {
            const message = messages.get(record.saved.id);
            checked++;
            if (mutation) mutationChecks++;
            if (!this.matches(record, message, mutation, device)) {
              mismatches++;
              this.sample('durableMismatch', { messageId: record.saved.id, requestId: record.requestId, chatId: id,
                userId: device.credentials.userId, mutation: mutation?.kind ?? null, mutationStatus: mutation?.status ?? null,
                expectedSequence: record.saved.sequence, actualSequence: message?.sequence ?? null,
                expectedVersion: mutation?.version ?? record.saved.messageVersion, actualVersion: message?.messageVersion ?? null,
                expectedBodyHash: hash(mutation?.body ?? record.body), actualBodyHash: hash(message?.body) });
            }
          }
        } catch (error) {
          unverified += batch.length;
          this.metrics.failure('verification', error);
          this.sample('resolveUnavailable', { chatId: id, userId: device.credentials.userId, code: error.code ?? 'unexpected', messageIds: batch.map(row => row.record.saved.id) });
        }
      }
    });
    const readOperations = [...this.state.reads.values()].flat().filter(record => record.confirmed && record.devices.length);
    const unobserved = readOperations.filter(record => !record.observed);
    const selectedFor = (peer, record) => this.state.measurementCutoff?.get(peer)?.selection === record.selections.get(peer)
      ? this.state.trafficCutoff - record.started : peer.stayedSelected(record.selections.get(peer), record.started);
    const keptOpen = record => record.devices.some(peer => selectedFor(peer, record) >= 5000);
    const missingReads = unobserved.filter(keptOpen);
    for (const record of missingReads) this.sample('readPropagationMissing', {
      readerId: this.state.devices[record.actor][0].credentials.userId, throughSequence: record.through,
      chatId: [...this.state.reads].find(([, rows]) => rows.includes(record))?.[0],
      peers: record.devices.map(peer => ({ userId: peer.credentials.userId, selectedSeconds: selectedFor(peer, record) / 1000 })),
    });
    const unreceived = records.flatMap(record => record.expected.filter(device => device !== record.device && !record.received.has(device))
      .map(device => ({ record, device, active: (record.group
        ? (this.state.measurementCutoff?.get(device)?.selection ?? device.selection)
        : (this.state.measurementCutoff?.get(device)?.connection ?? device.connection)) === record.lifecycles.get(device) })));
    for (const { record, device, active } of unreceived) if (active) this.sample('liveDeliveryMissing', {
      messageId: record.saved?.id ?? null, requestId: record.requestId, chatId: record.chatId, userId: device.credentials.userId,
    });
    const saved = records.filter(record => record.saved).length;
    for (const record of records.filter(record => !record.saved)) this.sample('terminalMissing', {
      requestId: record.requestId, userId: record.device.credentials.userId, chatId: record.chatId,
      rejected: record.rejected ?? null,
    });
    const plannedSends = this.state.actions.filter(action => confirmations.has(action.type)).length;
    return {
      plannedSends, dispatched: records.length, saved, missing: plannedSends - saved,
      pending: records.filter(record => !record.saved && !record.rejected).length,
      duplicates: (this.state.metrics.counts['correctness.conflictingTerminal'] ?? 0) + (this.metrics.counts['correctness.conflictingTerminal'] ?? 0),
      durableChecks: checked, durableMismatches: mismatches, durableUnverified: unverified, mutationChecks,
      recipientsExpected: records.reduce((total, record) => total + record.expected.filter(device => device !== record.device).length, 0),
      recipientsMissing: unreceived.filter(row => row.active).length, recipientsInterrupted: unreceived.filter(row => !row.active).length,
      readPropagationExpected: readOperations.length, readPropagationMissing: missingReads.length,
      readPropagationInterrupted: unobserved.length - missingReads.length,
    };
  }

  async close() {
    await workers([...this.sessions], 12, credentials => this.http.request(credentials, '/auth/logout', 'POST').catch(() => {}));
  }
}

export async function verifyRun(state) {
  const verification = new Verification(state);
  try {
    return await verification.run();
  } finally {
    await verification.close();
  }
}
