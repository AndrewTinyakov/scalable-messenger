import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from '../support/fixtures.mjs';
import { bounded, random } from './plan.mjs';
import { validOnlineCount, validPresence, validPresenceConfig } from './presence.mjs';
import { SendSchedule } from './sends.mjs';

const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export class Driver {
  constructor(options, metrics, http) {
    Object.assign(this, { options, metrics, http });
    this.records = new Map();
    this.byMessage = new Map();
    this.expectedMutations = new Map();
    this.latestVersions = new Map();
    this.tasks = new Set();
    this.foreground = new Map();
    this.readerTimes = new Map();
    this.disposable = [];
    this.deletedDisposable = false;
    this.chats = [];
    this.sockets = [];
    this.measuring = false;
    this.peakTasks = 0;
    this.peakMemory = 0;
    this.nextMutation = 0;
    this.nextLookup = 0;
    this.reconnected = false;
    this.rng = random(options.seed);
    this.sendSchedule = new SendSchedule({ rate: options.sendRate ?? 1, total: options.maxSends ?? 0, metrics, create: (index, scheduledAt) => this.createSend(index, scheduledAt), dispatch: record => this.dispatch(record) });
  }
  check(condition, message) { if (!condition) this.metrics.failure('correctness.failed', message); }
  receive(socket, event, at, recovered = false) {
    if (event.type === 'error' || event.type === 'send_rejected') {
      if (this.measuring) this.metrics.failure('operation.rejected', `${event.type}: ${event.code ?? event.reason}`);
      const record = this.records.get(event.requestId);
      if (record) { this.check(!record.saved, 'Request was both saved and rejected'); record.rejected = true; }
    }
    if (event.type === 'queued') {
      const record = this.records.get(event.requestId);
      if (record && socket.index === record.sender) record.queued = true;
    }
    if (event.type === 'chat_deleted' && this.chats.some(chat => chat.id === event.chatId)) this.check(false, 'Unexpected benchmark chat deletion');
    if (event.type === 'presence') this.check(validPresence(event, this.foreground.get(socket.index)?.watchIds), 'Invalid presence response');
    if (event.type === 'online_count') this.check(validOnlineCount(event), 'Invalid online count response');
    if (event.type === 'presence_config') this.check(validPresenceConfig(event), 'Invalid presence config response');
    if (event.type === 'message_changed') {
      const expected = this.expectedMutations.get(event.messageId);
      if (expected) {
        this.check(decimal(event.messageVersion) && decimal(event.mutationRevision), 'Invalid mutation version');
        const version = BigInt(event.messageVersion ?? '0');
        const previous = this.latestVersions.get(event.messageId) ?? 0n;
        if (version > previous) this.latestVersions.set(event.messageId, version);
        if (version >= BigInt(expected.version)) {
          expected.observed.add(socket.index);
          if (recovered) this.metrics.count('mutation.recoveredNotification');
        }
        if (version < previous) this.metrics.count('mutation.staleVersionIgnored');
        if (event.deletedAt) this.check(event.body === '', 'Tombstone leaked body');
      }
    }
    if (event.type === 'history_changed') {
      this.check(decimal(event.sequence) && decimal(event.mutationRevision) && decimal(event.visibilityRevision), 'Invalid history hint');
      for (const expected of this.expectedMutations.values()) {
        if (expected.chatId === event.chatId && decimal(event.mutationRevision) && BigInt(event.mutationRevision) >= BigInt(expected.revision)) {
          expected.observed.add(socket.index);
          if (recovered) this.metrics.count('mutation.recoveredNotification');
        }
      }
    }
    if (event.type !== 'message_saved') return;
    const record = this.records.get(event.requestId) ?? this.byMessage.get(event.messageId ?? event.id);
    if (!record) return;
    const messageId = event.messageId ?? event.id;
    this.check(event.chatId === record.chat.id && event.senderId === this.sockets[record.sender].session.userId && decimal(event.sequence) && decimal(event.messageVersion ?? '1') && timestamp(event.createdAt), 'Invalid saved message identity/shape');
    if (record.messageId && record.messageId !== messageId) { this.check(false, 'Duplicate terminal request produced different messages'); return; }
    this.check(typeof messageId === 'string', 'Missing saved message ID');
    record.messageId = messageId;
    this.byMessage.set(messageId, record);
    this.check(!record.rejected, 'Request was both rejected and saved');
    record.saved = true;
    this.check(event.body === record.body, 'Saved body mismatch');
    if (record.reply) this.check(event.replyToMessageId === record.reply, 'Saved reply target mismatch');
    if (!record.chat.members.includes(socket.index)) return;
    if (record.seen[socket.index]) { this.metrics.count('saved.duplicateNotification'); return; }
    record.seen[socket.index] = 1;
    record.received++;
    this.metrics.count(recovered ? 'saved.recoveredNotification' : 'saved.liveNotification');
    if (!recovered) this.metrics.observe('saved.notification', at - record.started);
    const selected = this.foreground.get(socket.index);
    if (selected?.chat.id === event.chatId && event.senderId !== socket.session.userId) {
      if (BigInt(event.sequence) > BigInt(selected.through)) {
        selected.through = event.sequence;
        if (!selected.visibleSince) selected.visibleSince = at;
      }
    }
  }
  launch(name, action) {
    if (this.tasks.size >= 32) { this.metrics.count(`${name}.admissionDeferred`); return false; }
    let work;
    work = Promise.resolve().then(action).catch(error => this.metrics.failure(`${name}.taskFailed`, error)).finally(() => this.tasks.delete(work));
    this.tasks.add(work);
    this.peakTasks = Math.max(this.peakTasks, this.tasks.size);
    return true;
  }
  async prepare(chats, sockets) {
    this.chats = chats;
    this.sockets = sockets;
    await bounded(sockets, 8, async socket => {
      const memberships = chats.filter(chat => chat.members.includes(socket.index));
      for (const chat of memberships) await socket.subscribe(chat);
      const chat = memberships[Math.floor(this.rng() * memberships.length)];
      if (!chat) return;
      const peers = chat.members.filter(index => index !== socket.index).slice(0, 100).map(index => sockets[index].session.userId);
      this.foreground.set(socket.index, { chat, watchIds: new Set(peers), through: '0', posted: '0', visibleSince: 0, nextAt: 0, busy: false });
      this.watchPresence(socket);
    });
    for (const chat of chats) {
      const socket = sockets[chat.members[0]];
      const requestId = ulid();
      const terminal = socket.wait(event => event.requestId === requestId && ['message_saved', 'send_rejected'].includes(event.type));
      socket.send({ type: 'send', chatId: chat.id, requestId, body: 'Mutable iteration target' });
      const event = await terminal;
      assert.equal(event.type, 'message_saved');
      chat.mutable = { id: event.messageId, version: event.messageVersion ?? '1', sender: socket.index };
      chat.baseline = event.sequence;
      const page = await this.http.request(socket.session, `/chats/${chat.id}/messages?limit=1`);
      chat.mutationBaseline = page.mutationRevision;
    }
    await this.prepareDeletion();
    await delay(1000);
  }
  watchPresence(socket) {
    const selected = this.foreground.get(socket.index);
    if (!selected) return;
    assert(socket.send({ type: 'watch_presence', reset: true, add: [...selected.watchIds] }), 'Presence watch send failed');
    if (selected.chat.kind === 'GROUP' && selected.chat.members.length <= 200) {
      assert(socket.send({ type: 'watch_online_count', chatId: selected.chat.id }), 'Online count watch send failed');
    }
  }
  createSend(index, scheduledAt) {
    const chat = this.chats[index % this.chats.length];
    const active = chat.members.slice(0, Math.max(1, Math.ceil(chat.members.length * .1)));
    const sender = active[Math.floor(this.rng() * active.length)];
    const requestId = ulid();
    const body = `feature-${this.options.seed}-${index} ` + 'x'.repeat(index % 10 === 0 ? 900 : 100);
    const reply = index % 5 === 0 ? chat.anchor.id : null;
    return { chat, sender, body, reply, scheduledAt, seen: new Uint8Array(this.sockets.length), received: 0, saved: false, queued: false, rejected: false, requestId };
  }
  dispatch(record) {
    const { chat, sender, body, reply, requestId } = record;
    const socket = this.sockets[sender];
    record.started = performance.now();
    this.records.set(requestId, record);
    const sent = socket.send({ type: 'send', chatId: chat.id, requestId, body, ...(reply ? { replyToMessageId: reply } : {}) });
    if (!sent) { this.records.delete(requestId); return false; }
    this.metrics.count('send.dispatched');
    if (this.measurementMs !== undefined) this.metrics.count('send.dispatchedAfterMeasurement');
    this.metrics.count(`send.${chat.cohort}.dispatched`);
    if (reply) this.metrics.count('send.reply');
    return true;
  }
  async mutate(chat, deleting = false) {
    const target = chat.mutable;
    if (target.deleted || target.busy) return;
    target.busy = true;
    try {
      const expectedVersion = target.version;
      const operation = deleting ? 'delete' : 'edit';
      const version = (BigInt(expectedVersion) + 1n).toString();
      const revision = (BigInt(chat.currentMutationRevision ?? chat.mutationBaseline) + 1n).toString();
      const expected = { version, revision, chatId: chat.id, observed: new Set() };
      this.expectedMutations.set(target.id, expected);
      if (deleting) {
        const deletion = await this.http.request(this.sockets[target.sender].session, `/chats/${chat.id}/deletions`, { method: 'POST', operation, body: { requestId: ulid(), scope: 'EVERYONE', target: 'MESSAGES', messageIds: [target.id] } });
        this.check(deletion.state === 'COMPLETED' && deletion.deletedRows === '1' && deletion.mutationRevision === revision, 'Message removal did not complete');
      } else {
        const message = await this.http.request(this.sockets[target.sender].session, `/chats/${chat.id}/messages/${target.id}`, { method: 'PATCH', operation, body: { expectedVersion, body: `Edited version ${version}` } });
        this.check(message.id === target.id && message.messageVersion === version && timestamp(message.editedAt), 'Mutation response version/body/timestamp mismatch');
      }
      target.version = version;
      chat.currentMutationRevision = revision;
      target.deleted = deleting;
      await this.http.request(this.sockets[target.sender].session, `/chats/${chat.id}/messages/${target.id}`, { method: 'PATCH', operation: 'staleEdit', expect: deleting ? [404] : [409], body: { body: 'stale', expectedVersion } });
    } finally { target.busy = false; }
  }
  async lookup(chat, index) {
    const creator = this.sockets[chat.members[0]];
    const viewer = this.sockets[chat.members[index % chat.members.length]];
    const summary = await this.http.request(viewer.session, `/chats/${chat.id}/reads`, { operation: 'summary' });
    this.check(decimal(summary.throughSequence) && decimal(summary.maxOtherReadSequence) && timestamp(summary.serverTime), 'Invalid read summary');
    const page = await this.http.request(viewer.session, `/chats/${chat.id}/messages/around?messageId=${chat.anchor.id}&limit=50`, { operation: 'around' });
    this.check(page.anchorMessageId === chat.anchor.id && Array.isArray(page.messages) && page.messages.length <= 50 && page.messages.some(message => message.id === chat.anchor.id) && decimal(page.mutationRevision), 'Invalid bounded around window');
    const detail = await this.http.request(creator.session, `/chats/${chat.id}/messages/${chat.anchor.id}/reads?limit=10`, { operation: 'details' });
    for (const reader of detail.readers) {
      const key = `${chat.id}:${reader.userId}`;
      const previous = this.readerTimes.get(key);
      this.check(!previous || Date.parse(previous) === Date.parse(reader.readAt), 'First read timestamp changed');
      this.readerTimes.set(key, reader.readAt);
    }
    const anchor = page.messages.find(message => message.id === chat.anchor.id);
    const eligible = anchor && !anchor.deletedAt && Date.parse(detail.serverTime) - Date.parse(anchor.createdAt) < 7 * 86400000;
    this.check(detail.detailsAvailable === Boolean(eligible), 'Reader timestamp age eligibility mismatch');
    this.check(typeof detail.detailsAvailable === 'boolean' && timestamp(detail.serverTime) && timestamp(detail.detailsExpiresAt) && detail.readers.length <= 10 && Object.hasOwn(detail, 'nextUserId') && detail.readers.every(reader => reader.userId !== creator.session.userId && timestamp(reader.readAt) && Date.parse(reader.readAt) <= Date.parse(detail.serverTime)), 'Invalid reader details/timestamps');
  }
  tickReads(now) {
    for (const [index, state] of this.foreground) {
      if (state.busy || state.through === state.posted || !state.visibleSince || now - state.visibleSince < 700 || now < state.nextAt) continue;
      state.busy = true;
      const throughSequence = state.through;
      const launched = this.launch('read', async () => {
        try {
          const response = await this.http.request(this.sockets[index].session, `/chats/${state.chat.id}/reads`, { method: 'POST', operation: 'read', body: { throughSequence } });
          this.check(decimal(response.throughSequence) && BigInt(response.throughSequence) >= BigInt(throughSequence) && timestamp(response.readAt) && timestamp(response.serverTime) && Date.parse(response.readAt) <= Date.parse(response.serverTime), 'Invalid read progress/timestamp');
          state.posted = throughSequence;
          state.visibleSince = state.through === throughSequence ? 0 : now;
        } finally { state.busy = false; state.nextAt = performance.now() + 1000; }
      });
      if (!launched) state.busy = false;
    }
  }
  async recover(socket) {
    for (const chat of socket.chats.values()) {
      let revision = chat.mutationBaseline;
      for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
        const page = await this.http.request(socket.session, `/chats/${chat.id}/messages/changes?afterRevision=${revision}&limit=100`, { operation: 'mutationRecovery' });
        if (page.resetRequired) throw new Error('Mutation recovery reset required during bounded run');
        for (const change of page.changes) {
          if (change.kind === 'UPSERT') {
            this.check(Boolean(change.message), 'Upsert change omitted its message');
            if (change.message) this.receive(socket, { ...change.message, messageId: change.message.id, type: 'message_changed', mutationRevision: change.revision }, performance.now(), true);
          } else if (change.kind === 'REMOVED') {
            const expected = this.expectedMutations.get(change.messageId);
            this.check(change.message === null && decimal(change.sequence), 'Removed change retained content or omitted sequence');
            if (expected && BigInt(change.revision) >= BigInt(expected.revision)) expected.observed.add(socket.index);
          } else this.check(false, 'Unexpected clear in preserved benchmark history');
        }
        if (page.nextRevision === page.lastRevision) break;
        if (BigInt(page.nextRevision) <= BigInt(revision) || pageIndex === 199) throw new Error('Mutation recovery did not advance within bounded pages');
        revision = page.nextRevision;
      }
      let sequence = chat.baseline;
      for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
        const requestedSequence = sequence;
        const page = await this.http.request(socket.session, `/chats/${chat.id}/messages?afterSeq=${sequence}&limit=100`, { operation: 'recovery' });
        for (const message of page.messages) {
          this.check(BigInt(message.sequence) > BigInt(sequence), 'Recovery sequence did not advance');
          sequence = message.sequence;
          this.receive(socket, { ...message, messageId: message.id, type: 'message_saved' }, performance.now(), true);
        }
        this.check(decimal(page.nextSequence) && page.coverageAfterSequence === requestedSequence && page.coverageThroughSequence === page.nextSequence && BigInt(page.nextSequence) >= BigInt(sequence), 'Invalid sparse recovery coverage');
        sequence = page.nextSequence;
        if (!page.hasMore) break;
        if (pageIndex === 199 || BigInt(sequence) <= BigInt(requestedSequence)) throw new Error('Recovery exceeded bounded pages or stopped advancing');
      }
    }
  }
  async reconnect() {
    const count = Math.floor(this.sockets.length * this.options.reconnectFraction);
    const chosen = this.sockets.slice(0, count);
    this.metrics.count('reconnect.initiated', chosen.length);
    await bounded(chosen, 8, socket => socket.disconnect());
    await delay(400);
    await bounded(chosen, 8, async socket => {
      await socket.connect();
      for (const chat of socket.chats.values()) await socket.subscribe(chat);
      this.watchPresence(socket);
      await this.recover(socket);
      this.metrics.count('reconnect.completed');
    });
  }
  async run() {
    this.measuring = true;
    this.http.measuring = true;
    for (const socket of this.sockets) socket.measuring = true;
    const start = performance.now();
    this.sendSchedule.startAt = start;
    let lookup = 0;
    let mutation = 0;
    while (!this.stopping && performance.now() - start < this.options.duration * 1000) {
      const now = performance.now();
      this.sendSchedule.tick(now);
      this.tickReads(now);
      if (now - start >= this.nextLookup) {
        const index = lookup;
        if (this.launch('lookup', () => this.lookup(this.chats[index % this.chats.length], index))) {
          lookup++;
          this.nextLookup = now - start + 2000;
        }
      }
      if (now - start >= this.nextMutation) {
        const index = mutation;
        if (this.launch('mutation', () => this.mutate(this.chats[Math.floor(index / 2) % this.chats.length], index % 2 === 1))) {
          mutation++;
          this.nextMutation = now - start + 5000;
        }
      }
      if (!this.reconnected && now - start >= this.options.duration * 500 && this.options.reconnectFraction > 0) {
        this.reconnected = this.launch('reconnect', () => this.reconnect());
      }
      if (!this.deletedDisposable && now - start >= this.options.duration * 800) {
        this.deletedDisposable = this.launch('chatDeletion', () => this.deleteDisposable());
      }
      this.peakMemory = Math.max(this.peakMemory, process.memoryUsage().rss);
      await delay(25);
    }
    this.measurementMs = performance.now() - start;
    if (this.stopping) throw new Error('Interrupted measurement');
    this.sendSchedule.tick(performance.now(), true);
    let initialTasksJoined = false;
    const initialTasks = Promise.allSettled([...this.tasks]).then(() => { initialTasksJoined = true; });
    while (!initialTasksJoined) {
      if (this.stopping) throw new Error('Interrupted measurement');
      this.sendSchedule.flush(performance.now());
      this.tickReads(performance.now());
      await delay(25);
    }
    await initialTasks;
    const drainUntil = performance.now() + this.options.drain * 1000;
    while (performance.now() < drainUntil && this.hasPendingWork()) {
      if (this.stopping) throw new Error('Interrupted measurement');
      this.sendSchedule.flush(performance.now());
      this.tickReads(performance.now());
      await delay(25);
    }
    this.sendSchedule.expire();
    await Promise.allSettled([...this.tasks]);
    await this.finalChecks();
    this.metrics.count('read.pendingAtEnd', [...this.foreground.values()].filter(state => state.through !== state.posted).length);
    this.measuring = false;
    this.http.measuring = false;
    for (const socket of this.sockets) socket.measuring = false;
  }
  hasPendingWork() {
    return this.sendSchedule.pending.length > 0 || this.tasks.size > 0 || [...this.foreground.values()].some(state => state.through !== state.posted) || [...this.records.values()].some(record => !record.saved || record.received < record.chat.members.length);
  }
  async prepareDeletion() {
    const creator = this.sockets[0];
    const group = await this.http.request(creator.session, '/chats/groups', { method: 'POST', body: { name: 'Disposable feature deletion', memberIds: [this.sockets[1].session.userId] } });
    this.disposable.push({ id: group.id, kind: 'GROUP', members: [0, 1], owned: true });
    let attempts = 0;
    for (let first = 0; first < this.sockets.length && attempts < 32; first++) {
      for (let second = first + 1; second < this.sockets.length && attempts++ < 32; second++) {
        const sender = this.sockets[first];
        const recipientId = this.sockets[second].session.userId;
        const lookup = await this.http.request(sender.session, `/chats/direct/${recipientId}`);
        if (lookup.chat) continue;
        const requestId = ulid();
        const terminal = sender.wait(event => event.requestId === requestId && ['message_saved', 'send_rejected'].includes(event.type));
        sender.send({ type: 'send', recipientId, requestId, body: 'Disposable direct deletion' });
        const result = await terminal;
        assert.equal(result.type, 'message_saved');
        this.disposable.push({ id: result.chatId, kind: 'DIRECT', members: [first, second], owned: true });
        return;
      }
    }
    this.metrics.count('chatDelete.directSetupSkippedNoUnusedPair');
  }
  async deleteDisposable() {
    for (const chat of this.disposable) {
      assert.ok(chat.owned && !this.chats.some(candidate => candidate.id === chat.id));
      await this.http.request(this.sockets[chat.members[0]].session, `/chats/${chat.id}`, { method: 'DELETE', operation: `chatDelete${chat.kind}`, expect: [204] });
      for (const member of chat.members) {
        await this.http.request(this.sockets[member].session, `/chats/${chat.id}/messages?limit=1`, { operation: 'deletedChatVerify', expect: [404] });
      }
    }
  }
  async finalChecks() {
    await bounded([...this.records.values()].filter(record => !record.saved), 8, async record => {
      const status = await this.http.request(this.sockets[record.sender].session, `/sends/${record.requestId}`, { operation: 'terminalLookup' });
      if (status.status === 'SAVED') { record.saved = true; record.messageId = status.messageId; }
      this.check(status.status === 'SAVED' || record.rejected, 'Dispatched request missing terminal result');
    });
    for (const record of this.records.values()) {
      if (record.saved) {
        this.metrics.count('send.saved');
        this.metrics.count('saved.expectedNotification', record.chat.members.length);
        this.metrics.count('saved.missingNotification', record.chat.members.length - record.received);
      }
      if (record.queued && !record.saved && !record.rejected) this.metrics.count('saved.missingAccepted');
    }
    for (const [messageId, expected] of this.expectedMutations) {
      const chat = this.chats.find(chat => chat.mutable.id === messageId);
      const page = await this.http.request(this.sockets[chat.members[0]].session, `/chats/${chat.id}/messages/resolve`, { method: 'POST', body: { messageIds: [messageId] }, operation: 'mutationVerify' });
      const message = page.messages.find(message => message.id === messageId);
      this.check(chat.mutable.deleted ? message === undefined : message?.messageVersion === expected.version, 'Final durable mutation version/removal mismatch');
      this.metrics.count('mutation.missingLiveNotification', chat.members.length - expected.observed.size);
    }
  }
  retained() {
    return { sendBacklog: this.sendSchedule.report(), pendingReadFrontiers: [...this.foreground.values()].filter(state => state.through !== state.posted).length, savedRequests: this.records.size, notificationBitmapBytes: this.records.size * this.sockets.length, messageIndex: this.byMessage.size, foregroundStates: this.foreground.size, mutationTargets: this.expectedMutations.size, readerTimestamps: this.readerTimes.size, socketChats: this.sockets.reduce((sum, socket) => sum + socket.chats.size, 0), pendingWaiters: this.sockets.reduce((sum, socket) => sum + socket.waiters.size, 0), pendingACKs: this.sockets.reduce((sum, socket) => sum + socket.acks.size, 0), peakTasks: this.peakTasks, peakHttpRequests: this.http.peak, peakRssBytes: this.peakMemory, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed };
  }
}
