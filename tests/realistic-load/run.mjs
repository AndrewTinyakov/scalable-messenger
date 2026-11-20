// Replays a plan in open loop: each action starts at its planned time, whatever the server is doing.
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from '../support/fixtures.mjs';
import { chatPath, Device, orderedMessages, pageSize } from './device.mjs';
import { authenticate, messageText, workers } from './setup.mjs';
import { resolveReference, schedule } from './schedule.mjs';
import { check, Fault, greater, isId, isSeq } from './transport.mjs';

const confirmations = new Set(['send', 'forward', 'direct']);
// In a sharded run the sender and the recipient can live in different processes, so a send carries its wall-clock
// time and the receiving worker measures delivery from it.
const SENT_AT = /\u2060t(\d{13})$/;

class Run {
  sends = new Map();
  messages = new Map();
  byAction = new Map();
  mutations = new Map();
  reads = new Map();
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
    for (const record of this.reads.get(id) ?? []) {
      // Only a peer that kept the chat open since the read counts; a later reopen measures navigation, not propagation.
      if (record.observed || !record.devices.includes(device) || record.selections.get(device) !== device.selection) continue;
      const value = record.actor === device.actor ? status.throughSequence : status.maxOtherReadSequence;
      if (greater(record.through, value)) continue;
      record.observed = true;
      this.metrics.observe('read.propagated', performance.now() - record.started);
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
    view.reads = through;
    const peers = this.expected(id, device.actor).filter(candidate => candidate !== device && candidate.selected?.id === id);
    const record = {
      actor: device.actor, through, started: performance.now(), devices: peers,
      selections: new Map(peers.map(peer => [peer, peer.selection])),
    };
    if (record.devices.length > 0) {
      if (!this.reads.has(id)) this.reads.set(id, []);
      this.reads.get(id).push(record);
    }
    const progress = await device.change(chatPath(id) + '/reads', 'POST', { throughSequence: through });
    check(isSeq(progress?.throughSequence) && !greater(through, progress.throughSequence), 'readDidNotAdvance');
    this.metrics.observe('read.accepted', performance.now() - record.started);
  }

  async editOrDelete(device, action, id, path) {
    const message = await this.reference(action, device, id);
    if (action.type === 'edit') {
      const body = messageText(action.bytes, action.textSeed);
      const edited = await device.change(path + '/messages/' + message.id, 'PATCH', { body, expectedVersion: message.messageVersion });
      check(edited?.id === message.id && edited.body === body && isSeq(edited.messageVersion) &&
        greater(edited.messageVersion, message.messageVersion), 'editDidNotAdvance');
      this.mutations.set(message.id, { kind: 'edit', version: edited.messageVersion, body, device });
      return;
    }
    const scope = action.type === 'deleteSelf' ? 'SELF' : 'EVERYONE';
    const requestId = ulid();
    const result = await device.change(path + '/deletions', 'POST', { requestId, scope, target: 'MESSAGES', messageIds: [message.id] });
    check(result?.operationId === requestId && result.scope === scope && result.target === 'MESSAGES', 'deletionResult');
    this.mutations.set(message.id, { kind: scope, device, requestId });
    await device.sync(id);
    await device.refreshDirectory();
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
        const message = await this.reference(action, device, source);
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
      case 'logout':
        await device.change('/auth/logout', 'POST');
        await device.close();
        delete device.credentials.cookie;
        return;
      case 'login':
        await authenticate(this.http, device.credentials, 'login');
        return device.startup(false, due);
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

  async verify() {
    let missing = 0;
    let checked = 0;
    let mismatches = 0;
    let mutationChecks = 0;
    const batches = new Map();
    const add = (id, record, device, expected) => {
      const key = device.credentials.userId + '/' + id;
      if (!batches.has(key)) batches.set(key, { id, device, checks: new Map() });
      batches.get(key).checks.set(record.saved.id, { record, expected });
    };
    for (const record of this.sends.values()) {
      if (!record.saved) {
        missing++;
        continue;
      }
      const id = record.saved.chatId;
      const mutation = this.mutations.get(record.saved.id);
      add(id, record, record.device, mutation);
      if (mutation) {
        const peer = this.roster.get(id)?.members.find(actor => actor !== record.device.actor);
        if (peer !== undefined) add(id, record, this.devices[peer][0], mutation.kind === 'SELF' ? null : mutation);
      }
    }
    await workers([...batches.values()], 12, async ({ id, device, checks }) => {
      const rows = [...checks.entries()];
      for (let start = 0; start < rows.length; start += 100) {
        const batch = rows.slice(start, start + 100);
        try {
          const page = await device.change(chatPath(id) + '/messages/resolve', 'POST', { messageIds: batch.map(([messageId]) => messageId) });
          const messages = new Map(orderedMessages(page, id, false).map(message => [message.id, message]));
          for (const [messageId, { record, expected }] of batch) {
            const message = messages.get(messageId);
            checked++;
            if (expected) mutationChecks++;
            const present = expected?.kind === 'SELF' || expected?.kind === 'EVERYONE' ? !message
              : message?.sequence === record.saved.sequence && message.body === (expected?.body ?? record.body) &&
                (!expected || message.messageVersion === expected.version);
            if (!present) mismatches++;
          }
        } catch (error) {
          this.metrics.failure('verification', error);
          mismatches += batch.length;
        }
      }
    });
    const records = [...this.sends.values()];
    const recipientsExpected = records.reduce((total, record) => total + record.expected.filter(device => device !== record.device).length, 0);
    // A recipient that closed its socket or switched chats before the frame arrived was interrupted,
    // not missed: the browser recovers those through HTTP when the chat is opened again.
    const unreceived = records.flatMap(record => record.expected
      .filter(device => device !== record.device && !record.received.has(device))
      .map(device => (record.group ? device.selection : device.connection) === record.lifecycles.get(device)));
    const recipientsMissing = unreceived.filter(Boolean).length;
    const recipientsInterrupted = unreceived.length - recipientsMissing;
    const readOperations = [...this.reads.values()].flat();
    // A read is missed when some peer kept the chat open past the 2 s server batch plus delivery and never
    // saw it. When every peer left sooner, it was interrupted: the browser shows it on the next opening.
    const unobserved = readOperations.filter(record => !record.observed);
    const keptOpen = record => record.devices.some(peer => peer.stayedSelected(record.selections.get(peer), record.started) >= 5000);
    const readPropagationMissing = unobserved.filter(keptOpen).length;
    const readPropagationInterrupted = unobserved.length - readPropagationMissing;
    const plannedSends = this.actions.filter(action => confirmations.has(action.type)).length;
    return {
      plannedSends, dispatched: records.length, saved: records.length - missing,
      missing: plannedSends - records.length + missing,
      pending: records.filter(record => !record.saved && !record.rejected).length,
      duplicates: this.metrics.counts['correctness.conflictingTerminal'] ?? 0,
      durableChecks: checked, durableMismatches: mismatches, mutationChecks,
      recipientsExpected, recipientsMissing, recipientsInterrupted,
      readPropagationExpected: readOperations.length, readPropagationMissing, readPropagationInterrupted,
    };
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
    correctness = await state.verify();
  } finally {
    await Promise.all(state.devices.flat().map(device => device.close()));
    while (state.background.size) await Promise.all([...state.background]);
    clearInterval(rssTimer);
    sampleRss();
  }
  const passed = state.failedActions === 0 && Object.keys(metrics.failures).length === 0 &&
    !metrics.counts.lagExceeded && !correctness.missing && !correctness.pending &&
    !correctness.duplicates && !correctness.durableMismatches && !correctness.recipientsMissing;
  return {
    format: 'messenger-realistic-load-report-v1', profile: plan.profile.name, seed: plan.seed, shard,
    users: plan.population.length, durationMs: plan.profile.durationMs,
    population: Object.fromEntries(plan.profile.personas.map(persona =>
      [persona.name, plan.population.filter(user => user.persona === persona.name).length])),
    sessions: plan.sessions.length, plannedActions: actions.length,
    schedule: { ...scheduleResult, lagLimitMs: plan.profile.timing.lagLimitMs },
    ticketAdmission: http.tickets.report(), failedActionSamples: state.failedSamples, correctness, passed, metrics: metrics.report(),
    ...(shard.count > 1 ? { rawMetrics: metrics.raw() } : {}),
  };
}
