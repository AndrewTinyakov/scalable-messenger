import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Http } from '../features-load/http.mjs';
import { Metrics } from '../features-load/metrics.mjs';
import { Socket } from '../features-load/socket.mjs';
import { ticketAdmission } from '../features-load/tickets.mjs';
import { ulid } from '../support/fixtures.mjs';

export const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

export function snapshot(page, coverage = false) {
  for (const key of ['snapshotSequence', 'visibilitySeq', 'clearedThroughSequence', 'globalClearedThroughSequence']) assert.ok(decimal(page[key]), `Invalid ${key}`);
  if (coverage) {
    assert.ok(decimal(page.coverageAfterSequence) && decimal(page.coverageThroughSequence));
    assert.ok(BigInt(page.coverageAfterSequence) <= BigInt(page.coverageThroughSequence));
    assert.ok(BigInt(page.coverageThroughSequence) <= BigInt(page.snapshotSequence));
    for (const row of page.messages) assert.ok(BigInt(row.sequence) > BigInt(page.coverageAfterSequence) && BigInt(row.sequence) <= BigInt(page.coverageThroughSequence), 'Row outside certified coverage');
  }
  return page;
}

export class Runtime {
  constructor(options) {
    this.options = options;
    this.metrics = new Metrics();
    this.http = new Http(options, this.metrics);
    this.http.measuring = true;
    this.sockets = [];
    this.events = [];
    this.seen = new Map();
    this.latencies = [];
  }
  async accounts() {
    const sessions = [];
    let secondDevice;
    for (let index = 0; index < 3; index++) {
      const password = randomBytes(24).toString('hex');
      const username = `deletion_${this.options.tag}_${index}`;
      const register = await fetch(`${this.options.api}/v1/auth/register`, {
        method: 'POST', headers: { origin: this.options.origin, 'x-messenger-csrf': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId: `benchmark-${index}` }), signal: AbortSignal.timeout(15000),
      });
      assert.equal(register.status, 201, 'Benchmark account registration failed');
      const account = await register.json();
      const cookie = register.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      assert.ok(cookie, 'Missing session cookie');
      sessions.push({ userId: account.user.id, cookie });
      if (index === 0) {
        const login = await fetch(`${this.options.api}/v1/auth/login`, {
          method: 'POST', headers: { origin: this.options.origin, 'x-messenger-csrf': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ username, password, deviceId: 'benchmark-second-device' }), signal: AbortSignal.timeout(15000),
        });
        assert.equal(login.status, 200, 'Second-device login failed');
        await login.arrayBuffer();
        secondDevice = { userId: account.user.id, cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
      }
    }
    return { sessions, secondDevice };
  }
  async connect(source) {
    for (const session of [...source.sessions, source.secondDevice]) {
      assert.ok(session?.cookie && session.userId);
      const socket = new Socket(this.sockets.length, session, this.http, this.options, this.metrics, (device, frame, at) => {
        if (this.events.length === 256) this.events.shift();
        this.events.push({ device: device.index, type: frame.type, chatId: frame.chatId, sequence: frame.sequence, seq: frame.seq, memberSeq: frame.memberSeq });
        const record = this.seen.get(frame.requestId);
        if (record && frame.type === 'message_saved') {
          assert.equal(frame.body, record.body);
          if (record.id) assert.equal(record.id, frame.messageId, 'Retry changed saved identity');
          record.id = frame.messageId;
          record.devices.add(device.index);
          record.eventIds.add(frame.eventId);
          if (!record.finished) { record.finished = true; this.latencies.push(at - record.started); }
        }
      });
      this.sockets.push(socket);
      await socket.connect();
    }
  }
  api(actor, path, options = {}) { return this.http.request(this.sockets[actor].session, path, options); }
  async group(name, members = [1, 2]) {
    const chat = await this.api(0, '/chats/groups', { method: 'POST', body: { name: `Scoped deletion ${this.options.tag} ${name}`, memberIds: members.map(index => this.sockets[index].session.userId) } });
    const fixture = { id: chat.id, kind: 'GROUP', name: chat.name, owned: true, members: [0, ...members, 3] };
    for (const index of fixture.members) await this.sockets[index].subscribe({ ...fixture, baseline: '0' });
    return fixture;
  }
  async send(actor, frame, requestId = ulid(), body = `scoped-${requestId}`) {
    const socket = this.sockets[actor];
    assert.ok(this.seen.size < 20000, 'Retained request cap reached');
    if (!this.seen.has(requestId)) this.seen.set(requestId, { body, devices: new Set(), eventIds: new Set(), started: performance.now() });
    const terminal = socket.wait(event => event.requestId === requestId && ['message_saved', 'send_rejected'].includes(event.type));
    assert.ok(socket.send({ type: 'send', requestId, body, ...frame }));
    const saved = await terminal;
    assert.equal(saved.type, 'message_saved', `Send rejected: ${saved.reason}`);
    return { ...saved, id: saved.messageId, requestId, body };
  }
  async deletion(actor, chat, scope, target, messageIds, requestId = ulid(), expect = [200, 201, 202]) {
    assert.ok(chat.owned, 'Deletion requires a benchmark-owned chat');
    return this.api(actor, `/chats/${chat.id}/deletions`, { method: 'POST', body: { requestId, scope, target, ...(messageIds ? { messageIds } : {}) }, operation: `deletion.${scope}.${target}`, expect });
  }
  async resolve(actor, chat, ids) {
    const result = await this.api(actor, `/chats/${chat.id}/messages/resolve`, { method: 'POST', body: { messageIds: ids }, operation: 'resolve' });
    return snapshot(result);
  }
  async hints(action, chat, devices, scope = 'SELF') {
    const visibility = await this.api(devices[0], `/chats/${chat.id}/visibility`);
    const [frameKey, visibilityKey] = scope === 'SELF' ? ['memberSeq', 'visibilitySeq'] : ['seq', 'mutationSeq'];
    const waits = devices.map(index => this.sockets[index].wait(frame => frame.type === 'history_changed' && frame.chatId === chat.id && decimal(frame[frameKey]) && BigInt(frame[frameKey]) > BigInt(visibility[visibilityKey])));
    const results = await Promise.allSettled([action(), ...waits]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results[0].value;
  }
  async complete(actor, chat, operation, timeoutSeconds = this.options.timeout) {
    const start = performance.now();
    let progress = operation;
    let previous = 0n;
    while (progress.state !== 'COMPLETED') {
      assert.ok(performance.now() - start < timeoutSeconds * 1000, 'Purge completion timed out');
      assert.ok(decimal(progress.deletedRows) && BigInt(progress.deletedRows) >= previous, 'Purge progress regressed');
      previous = BigInt(progress.deletedRows);
      await delay(100);
      progress = await this.api(actor, `/chats/${chat.id}/deletions/${operation.operationId}`, { operation: 'purgeProgress' });
    }
    return { ...progress, observedCompletionMs: performance.now() - start };
  }
  async notifications(saved, devices) {
    const deadline = performance.now() + 10000;
    while (devices.some(device => !this.seen.get(saved.requestId).devices.has(device)) && performance.now() < deadline) await delay(25);
    assert.deepEqual(devices.filter(device => !this.seen.get(saved.requestId).devices.has(device)), [], 'Missing saved notifications');
  }
  async close() {
    await Promise.allSettled(this.sockets.map(socket => socket.close()));
    this.http.controller.abort();
    await ticketAdmission.join();
  }
}
