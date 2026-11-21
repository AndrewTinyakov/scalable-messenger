// Replays a plan in open loop: each action starts at its planned time, whatever the server is doing.
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from '../support/fixtures.mjs';
import { chatPath, Device, orderedMessages, pageSize } from './device.mjs';
import { authenticate, messageText, workers } from './setup.mjs';
import { resolveReference, schedule } from './schedule.mjs';
import { verifyRun } from './verification.mjs';
import { check, Fault, greater, Http, isId, isSeq, Measurements } from './transport.mjs';

const confirmations = new Set(['send', 'forward', 'direct']);
// In a sharded run the sender and the recipient can live in different processes, so a send carries its wall-clock
// time and the receiving worker measures delivery from it.
const SENT_AT = /\u2060t(\d{13})$/;

export class Run {
  sends = new Map();
  messages = new Map();
  byAction = new Map();
  mutations = new Map();
  reads = new Map();
  readFrontiers = new Map();
  readResults = new Set();
  diagnostics = [];
  background = new Set();
  failedActions = 0;
  failedSamples = [];

  // HTTP can return a message before its sender's confirmation indexes it; hold those sightings until then.
  early = new Map();

  constructor(plan, manifest, http, metrics, shard = { index: 0, count: 1 }) {
    Object.assign(this, { plan, manifest, http, metrics, shard, signal: http.controller.signal, capacity: http.options.capacity ?? 1 });
    this.remoteSightings = new Set();
    this.devices = manifest.devices.map((devices, actor) => devices.map(credentials => new Device(this, credentials, actor)));
    this.roster = new Map(plan.chats.map(chat => [manifest.chats[chat.id], chat]));
  }

  saved(record, result, live) {
    check(isId(result.messageId) && isId(result.chatId) && isSeq(result.sequence), 'invalidSaved');
    check(!record.chatId || record.chatId === result.chatId, 'wrongSendChat');
    if (record.rejected || (record.saved && record.saved.id !== result.messageId) ||
        (this.messages.has(result.messageId) && this.messages.get(result.messageId) !== record)) {
      this.metrics.count('correctness.conflictingTerminal');
      return;
    }
    if (record.saved) return;
    record.saved = {
      id: result.messageId, chatId: result.chatId, sequence: result.sequence,
      messageVersion: result.messageVersion ?? '1',
    };
    this.messages.set(result.messageId, record);
    for (const [device, at] of this.early.get(result.messageId) ?? []) this.observeRecovered(record, device, result.messageId, at);
    this.early.delete(result.messageId);
    this.metrics.observe(live ? 'send.ownAck' : 'send.statusConfirmation', performance.now() - record.sent);
    record.finish(record.saved);
  }

  stamped(body) {
    if (this.shard.count === 1) return body;
    const stamp = '\u2060t' + Date.now();
    return [...body].slice(0, 4000 - stamp.length).join('') + stamp;
  }

  notification(device, frame) {
    const record = this.sends.get(frame.requestId) ?? this.messages.get(frame.messageId);
    if (!record) {
      this.remoteNotification(device, frame);
      return;
    }
    if (device === record.device) this.saved(record, frame, true);
    const prior = record.received.get(device);
    if (prior !== undefined) {
      if (prior !== frame.messageId) this.metrics.count('correctness.conflictingTerminal');
      else this.metrics.count('correctness.repeatedNotification');
      return;
    }
    record.received.set(device, frame.messageId);
    if (device !== record.device && record.expected.includes(device)) {
      this.metrics.observe('send.recipientLive', performance.now() - record.sent);
    }
  }

  remoteNotification(device, frame) {
    const sentAt = this.shard.count > 1 && !frame.forwardedFromUserId && SENT_AT.exec(frame.body ?? '')?.[1];
    const key = device.credentials.userId + '/' + frame.messageId;
    if (!sentAt || frame.senderId === device.credentials.userId || this.remoteSightings.has(key)) return;
    if (this.remoteSightings.size > 500000) this.remoteSightings.clear();
    this.remoteSightings.add(key);
    this.metrics.observe('send.recipientLive', Math.max(0, Date.now() - Number(sentAt)));
    this.metrics.count('send.recipientLive.crossShard');
  }

  recovered(device, message) {
    const record = this.messages.get(message.id);
    if (record) {
      this.observeRecovered(record, device, message.id, performance.now());
    } else if (this.early.size < 50000) {
      if (!this.early.has(message.id)) this.early.set(message.id, new Map());
      if (!this.early.get(message.id).has(device)) this.early.get(message.id).set(device, performance.now());
    }
  }

  observeRecovered(record, device, messageId, at) {
    if (record.received.has(device) || !record.expected.includes(device)) return;
    record.received.set(device, messageId);
    this.metrics.observe('send.recipientRecovered', Math.max(0, at - record.sent));
  }

  readNotification(device, id, status) {
    const key = device.actor + '/' + id;
    if (isSeq(status.throughSequence) && greater(status.throughSequence, this.readFrontiers.get(key) ?? '0')) this.readFrontiers.set(key, status.throughSequence);
    for (const record of this.reads.get(id) ?? []) {
      // Only a peer that kept the chat open since the read counts; a later reopen measures navigation, not propagation.
      if (record.observed || !record.devices.includes(device) || record.selections.get(device) !== device.selection) continue;
      const value = record.actor === device.actor ? status.throughSequence : status.maxOtherReadSequence;
      if (greater(record.through, value)) continue;
      record.observed = true;
      record.observedAt = performance.now();
      if (record.confirmed) this.metrics.observe('read.propagated', record.observedAt - record.started);
    }
  }

  async send(device, due, chatId, frame, expected) {
    const socket = device.requireSocket();
    const lag = Math.max(0, performance.now() - due);
    this.metrics.observe('send.wireSchedulingLag', lag);
    if (lag > this.plan.profile.timing.lagLimitMs) this.metrics.count('lagExceeded');
    const requestId = ulid();
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const record = {
      requestId, device, chatId, expected, received: new Map(),
      group: this.roster.get(chatId)?.kind === 'GROUP',
      lifecycles: new Map(expected.map(recipient =>
        [recipient, this.roster.get(chatId)?.kind === 'GROUP' ? recipient.selection : recipient.connection])),
      sent: performance.now(), body: frame.body,
      finish: (message, rejected) => {
        device.pendingSends.delete(record);
        if (rejected) {
          if (record.saved) this.metrics.count('correctness.conflictingTerminal');
          record.rejected = rejected;
        }
        finish(message);
      },
    };
    this.sends.set(requestId, record);
    device.pendingSends.add(record);
    let abort;
    let timeout;
    try {
      socket.send({ type: 'send', requestId, ...frame });
      const wait = new Promise(resolve => {
        abort = () => resolve(null);
        this.signal.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(abort, 8000);
      });
      await Promise.race([done, wait]);
      if (!record.saved && !record.rejected && !this.signal.aborted) await device.reconcile();
      if (!record.saved) throw new Fault(record.rejected ?? 'sendPending');
      return record.saved;
    } finally {
      clearTimeout(timeout);
      if (abort) this.signal.removeEventListener('abort', abort);
    }
  }

  expected(id, actor, peer) {
    if (peer !== undefined) return [actor, peer].flatMap(user => this.devices[user]).filter(device => device.connected);
    // Group frames reach only devices whose subscription the gateway confirmed.
    const chat = this.roster.get(id);
    return chat.members.flatMap(user => this.devices[user]).filter(device =>
      device.connected && (chat.kind === 'DIRECT' || device.subscribedTo === id));
  }

  async reference(action, device, id) {
    // A reply's parent can belong to another shard's user; quote the latest message in the chat instead.
    const reference = action.reference?.send !== undefined && this.shard.count > 1 && !this.byAction.has(action.reference.send)
      ? { back: 1 } : action.reference;
    const result = await resolveReference(reference, key => this.byAction.get(key), device.view(id).messages);
    check(result && result.chatId === id, 'unresolvedReference');
    return result;
  }

  async knownChat(device, id) {
    const directory = device.directory.find(chat => chat.id === id);
    if (directory) return directory;
    const result = await device.get(chatPath(id));
    check(result?.id === id && Array.isArray(result.members), 'invalidChat');
    return result;
  }

  async read(device, id) {
    if (!device.foreground || device.selected?.id !== id) return;
    const view = device.view(id);
    await view.ready;
    if (view.detached) return;
    const message = view.messages.findLast(message => message.senderId !== device.credentials.userId);
    if (!message || !greater(message.sequence, view.reads)) return;
    const through = message.sequence;
    const key = device.actor + '/' + id;
    if (!greater(through, this.readFrontiers.get(key) ?? '0')) {
      this.metrics.count('read.noop');
      view.reads = through;
      return;
    }
    view.reads = through;
    const peers = this.expected(id, device.actor).filter(candidate => candidate !== device && candidate.selected?.id === id);
    const record = {
      actor: device.actor, through, started: performance.now(), devices: peers, confirmed: false,
      selections: new Map(peers.map(peer => [peer, peer.selection])),
    };
    if (!this.reads.has(id)) this.reads.set(id, []);
    this.reads.get(id).push(record);
    try {
      const progress = await device.change(chatPath(id) + '/reads', 'POST', { throughSequence: through });
      check(isSeq(progress?.throughSequence) && !greater(through, progress.throughSequence), 'readDidNotAdvance');
      const result = key + '/' + progress.throughSequence + '/' + progress.readAt;
      record.confirmed = !this.readResults.has(result);
      this.readResults.add(result);
      if (greater(progress.throughSequence, this.readFrontiers.get(key) ?? '0')) this.readFrontiers.set(key, progress.throughSequence);
      this.metrics.count(record.confirmed ? 'read.frontierConfirmed' : 'read.noop');
      if (record.confirmed && record.observed) this.metrics.observe('read.propagated', record.observedAt - record.started);
      this.metrics.observe('read.accepted', performance.now() - record.started);
    } finally {
      if (!record.confirmed) this.reads.set(id, this.reads.get(id).filter(candidate => candidate !== record));
    }
  }

  async editOrDelete(device, action, id, path) {
    const message = await this.reference(action, device, id);
    const mutation = { kind: action.type === 'edit' ? 'edit' : action.type === 'deleteSelf' ? 'SELF' : 'EVERYONE',
      device, status: 'pending', before: { body: message.body, version: message.messageVersion },
      ...(action.type === 'edit' ? { body: messageText(action.bytes, action.textSeed), version: String(BigInt(message.messageVersion) + 1n) } : { requestId: ulid() }) };
    this.mutations.set(message.id, mutation);
    try {
      if (mutation.kind === 'edit') {
        const edited = await device.change(path + '/messages/' + message.id, 'PATCH', { body: mutation.body, expectedVersion: message.messageVersion });
        check(edited?.id === message.id && edited.body === mutation.body && isSeq(edited.messageVersion) &&
          greater(edited.messageVersion, message.messageVersion), 'editDidNotAdvance');
        mutation.version = edited.messageVersion;
      } else {
        const result = await device.change(path + '/deletions', 'POST', { requestId: mutation.requestId, scope: mutation.kind, target: 'MESSAGES', messageIds: [message.id] });
        check(result?.operationId === mutation.requestId && result.scope === mutation.kind && result.target === 'MESSAGES', 'deletionResult');
      }
      mutation.status = 'confirmed';
    } catch (error) {
      mutation.status = error.code === 'network' || /^http5/.test(error.code) ? 'uncertain' : 'rejected';
      throw error;
    }
    if (mutation.kind !== 'edit') {
      await device.sync(id);
      await device.refreshDirectory();
    }
  }

  async direct(device, action, due) {
    const peer = this.manifest.devices[action.peer][0];
    const result = await device.get('/users', { query: peer.username });
    check(Array.isArray(result) ? result.some(user => user.id === peer.userId) : result?.users?.some(user => user.id === peer.userId), 'lookupMissingPeer');
    const saved = await this.send(device, due, null, {
      recipientId: peer.userId, body: this.stamped(messageText(action.bytes, action.textSeed)),
    }, this.expected(null, action.actor, action.peer));
    this.roster.set(saved.chatId, { kind: 'DIRECT', members: [action.actor, action.peer] });
    await device.refreshDirectory();
    await device.openChat(await this.knownChat(device, saved.chatId), performance.now());
    return saved;
  }

  async group(device, action) {
    const [a, b, added] = action.peers.map(peer => this.manifest.devices[peer][0]);
    for (const peer of [a, b]) await device.get('/users', { query: peer.username });
    const chat = await device.change('/chats/groups', 'POST', {
      name: 'Realistic ' + this.manifest.tag + ' session ' + action.session,
      memberIds: [a.userId, b.userId],
    });
    check(isId(chat?.id) && Array.isArray(chat.members), 'invalidChat');
    await device.refreshDirectory();
    await device.openChat(chat, performance.now());
    const path = chatPath(chat.id);
    await Promise.all([device.get(path), device.get(path + '/members', { limit: 50 })]);
    await device.get('/users', { query: added.username });
    await device.change(path + '/members', 'POST', { memberIds: [added.userId] });
    await Promise.all([device.get(path), device.get(path + '/members', { limit: 50 })]);
    await device.change(path + '/members/' + added.userId, 'DELETE');
    await Promise.all([device.get(path), device.get(path + '/members', { limit: 50 })]);
  }

  async perform(action, due) {
    const device = this.devices[action.actor][action.device];
    const id = action.chat === null ? null : this.manifest.chats[action.chat];
    const path = id && chatPath(id);
    const { type } = action;
    if (id && !['chatOpen', 'disconnect', 'reconnect', 'background', 'foreground'].includes(type)) {
      check(device.selected?.id === id, 'plannedChatUnavailable');
      await device.view(id).ready;
    }
    switch (type) {
      case 'appOpen': return device.startup(true, due);
      case 'appClose': return device.close();
      case 'sidebar': return device.sidebar();
      case 'background': device.foreground = false; return;
      case 'foreground':
        device.foreground = true;
        return Promise.all([
          device.get('/auth/session'), device.refreshDirectory(), device.reconcile(),
          device.catchUp(id), device.refreshFeatures(device.selected),
        ]);
      case 'disconnect': return device.disconnect();
      case 'reconnect':
        await device.connect();
        device.subscribe(device.selected);
        device.backgroundTask('sidebar.initial', async () => {
          await delay(250, undefined, { signal: this.signal });
          device.sidebar();
        });
        await Promise.all([device.catchUp(id), device.refreshFeatures(device.selected), device.reconcile()]);
        this.metrics.observe('reconnect.caughtUp', performance.now() - due);
        return;
      case 'chatOpen': return device.openChat(await this.knownChat(device, id), due);
      case 'chatRefresh': return device.refreshFeatures(device.selected);
      case 'scroll': {
        const first = device.view(id).messages[0];
        check(first, 'unresolvedReference');
        if (first.sequence === '1') return;
        const page = await device.get(path + '/messages', { beforeSeq: first.sequence, limit: pageSize });
        const view = device.install(id, page);
        view.detached = view.messages[0] ?? first;
        return;
      }
      case 'jump': {
        const view = device.view(id);
        const quote = view.messages.filter(message => isId(message.replyToMessageId)).at(-action.reference.quotedBack);
        // Same guard as MessageItem's unavailableQuote: the browser disables these quotes.
        if (!quote || quote.replyDeleted || quote.replySenderId == null || quote.replyBody == null) {
          this.metrics.count('jump.unavailable');
          return;
        }
        const cached = view.messages.find(message => message.id === quote.replyToMessageId);
        if (cached) {
          this.metrics.count('jump.cached');
          view.detached = cached;
          return;
        }
        this.metrics.count('jump.http');
        try {
          return await device.around(id, { id: quote.replyToMessageId });
        } catch (error) {
          // The quoted message was deleted after this page loaded. The browser shows
          // "Could not find the original message"; that is an expected outcome, not a failure.
          if (error.code !== 'http404') throw error;
          this.metrics.count('jump.anchorGone');
          return;
        }
      }
      case 'read': return this.read(device, id);
      case 'send': {
        const reply = action.reference && await this.reference(action, device, id);
        return this.send(device, due, id, {
          chatId: id, body: this.stamped(messageText(action.bytes, action.textSeed)),
          ...(reply ? { replyToMessageId: reply.id } : {}),
        }, this.expected(id, action.actor));
      }
      case 'forward': {
        const source = this.manifest.chats[action.source];
        const destination = device.selected;
        await device.openChat(await this.knownChat(device, source), performance.now());
        const seed = this.plan.chats[action.source].history.length;
        const page = await device.get(chatPath(source) + '/messages', { beforeSeq: String(seed + 1), limit: pageSize });
        const message = orderedMessages(page, source).at(-1);
        check(message && !greater(message.sequence, String(seed)), 'forwardSourceUnavailable');
        const sent = this.send(device, due, id, {
          chatId: id, body: message.body,
          forwardFromChatId: source, forwardFromMessageId: message.id,
        }, this.expected(id, action.actor));
        const [saved] = await Promise.all([sent, device.openChat(destination, performance.now())]);
        return saved;
      }
      case 'edit':
      case 'deleteSelf':
      case 'deleteEveryone': return this.editOrDelete(device, action, id, path);
      case 'readers': {
        const message = await this.reference(action, device, id);
        return device.get(path + '/messages/' + message.id + '/reads', { limit: 50 });
      }
      case 'pinMessage': {
        const message = await this.reference(action, device, id);
        const scope = device.selected.kind === 'DIRECT' ? 'SELF' : 'EVERYONE';
        await device.change(path + '/pins/' + message.id, 'PUT', { scope });
        return device.get(path + '/pins', { limit: 50 });
      }
      case 'pinChat': return device.change(path + '/pin', 'PUT');
      case 'mute': return device.change(path + '/mute', 'PUT', { durationSeconds: 3600 });
      case 'unread': return device.change(path + '/unread-mark', 'PUT');
      case 'sessions': return device.get('/auth/sessions');
      case 'lookup': return device.get('/users', { query: this.manifest.devices[action.peer][0].username });
      case 'direct': return this.direct(device, action, due);
      case 'group': return this.group(device, action);
      case 'logout': return device.session(async () => {
        await device.change('/auth/logout', 'POST');
        delete device.credentials.cookie;
        await device.close();
      });
      case 'login': return device.session(async () => {
        await authenticate(this.http, device.credentials, 'login');
        return device.startup(false, due);
      });
      default: throw new Fault('unknownAction');
    }
  }

  dispatch(action, due) {
    const started = performance.now();
    this.metrics.count('offered.' + action.type);
    this.metrics.count('offered.' + action.persona + '.' + action.type);
    const task = this.perform(action, due).then(result => {
      this.metrics.observe('action.' + action.type, performance.now() - started);
      this.metrics.count('completed.' + action.type);
      this.metrics.count('completed.' + action.persona + '.' + action.type);
      return result;
    }).catch(error => {
      this.failedActions++;
      if (this.failedSamples.length < 30) this.failedSamples.push({ id: action.id, type: action.type, code: error instanceof Fault ? error.code : 'unexpected' });
      this.metrics.failure('action.' + action.type, error);
      return null;
    });
    if (confirmations.has(action.type)) this.byAction.set(action.id, task);
    return task;
  }

  async finishTraffic() {
    this.measurementCutoff = new Map(this.devices.flat().map(device => [device, { connection: device.connection, selection: device.selection }]));
    await Promise.all(this.devices.flat().map(device => device.close()));
    while (this.background.size) await Promise.all([...this.background]);
    this.acceptingEvents = false;
  }

  async verify() {
    return verifyRun(this);
  }

}

export async function run(plan, manifest, http, metrics, { shard = { index: 0, count: 1 }, startAt } = {}) {
  const state = new Run(plan, manifest, http, metrics, shard);
  const actions = shard.count > 1 ? plan.actions.filter(action => action.actor % shard.count === shard.index) : plan.actions;
  state.actions = actions;
  if (startAt !== undefined) {
    const wait = startAt - Date.now();
    check(wait > -1000, 'startAtPassed');
    if (wait > 0) await delay(wait, undefined, { signal: state.signal });
  }
  // The generator samples its own health, so a saturated driver can be told apart from a slow server.
  let lastSample = performance.now();
  let lastUtilization = performance.eventLoopUtilization();
  const sampleRss = () => {
    metrics.rss = Math.max(metrics.rss, process.memoryUsage.rss());
    const now = performance.now();
    const utilization = performance.eventLoopUtilization();
    metrics.observe('generator.timerDelay', Math.max(0, now - lastSample - 1000));
    metrics.observe('generator.eventLoopBusyPercent', 100 * performance.eventLoopUtilization(utilization, lastUtilization).utilization);
    metrics.observe('generator.inflightHttp', http.inflight);
    [lastSample, lastUtilization] = [now, utilization];
  };
  if (plan.profile.ramp) metrics.startStages(plan.profile.ramp.stages);
  sampleRss();
  const rssTimer = setInterval(sampleRss, 1000);
  let scheduleResult;
  let correctness;
  try {
    scheduleResult = await schedule(actions, (action, due) => state.dispatch(action, due), {
      signal: state.signal,
      lag: (ms, action) => {
        metrics.observe('schedulingLag', ms);
        metrics.observe('schedulingLag.' + action.type, ms);
        if (ms > plan.profile.timing.lagLimitMs) metrics.count('lagExceeded');
      },
      failed: (action, error) => { state.failedActions++; metrics.failure('scheduler.' + action.type, error); },
      limit: 512 * state.capacity,
    });
    while (state.background.size) await Promise.all([...state.background]);
    await state.finishTraffic();
    state.verificationMetrics = new Measurements();
    state.verificationHttp = new Http(http.options, state.verificationMetrics);
    correctness = await state.verify();
  } finally {
    await Promise.all(state.devices.flat().map(device => device.close()));
    while (state.background.size) await Promise.all([...state.background]);
    clearInterval(rssTimer);
    sampleRss();
    state.verificationHttp?.controller.abort();
  }
  const passed = state.failedActions === 0 && Object.keys(metrics.failures).length === 0 &&
    !metrics.counts.lagExceeded && !correctness.missing && !correctness.pending &&
    !correctness.duplicates && !correctness.durableMismatches && !correctness.durableUnverified && !correctness.recipientsMissing && !correctness.readPropagationMissing;
  return {
    format: 'messenger-realistic-load-report-v1', profile: plan.profile.name, seed: plan.seed, shard,
    users: plan.population.length, durationMs: plan.profile.durationMs,
    population: Object.fromEntries(plan.profile.personas.map(persona =>
      [persona.name, plan.population.filter(user => user.persona === persona.name).length])),
    sessions: plan.sessions.length, plannedActions: actions.length,
    schedule: { ...scheduleResult, lagLimitMs: plan.profile.timing.lagLimitMs },
    diagnostics: state.diagnostics, verificationMetrics: state.verificationMetrics.report(),
    ...(shard.count > 1 ? { verificationRawMetrics: state.verificationMetrics.raw() } : {}),
    ticketAdmission: http.tickets.report(), failedActionSamples: state.failedSamples, correctness, passed, metrics: metrics.report(),
    ...(shard.count > 1 ? { rawMetrics: metrics.raw() } : {}),
  };
}
