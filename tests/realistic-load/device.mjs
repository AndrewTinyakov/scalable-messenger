// One signed-in client device: its socket, selected chat, cached history and background refreshes.
// It sends the same requests and frames as the browser client for each user-visible flow.
import { setTimeout as delay } from 'node:timers/promises';
import { check, Fault, greater, isId, isSeq, join, query, Socket } from './transport.mjs';

const STATE_CHECK_MS = 60_000;
const statusCodes = new Set(['INVALID_FRAME', 'RATE_LIMITED', 'ROOM_LIMIT', 'UNAUTHORIZED', 'DEPENDENCY_UNAVAILABLE', 'PUBLISH_UNKNOWN', 'PUBLISH_FAILED']);
const rejections = new Set(['NOT_A_MEMBER', 'CHAT_NOT_FOUND', 'RECIPIENT_NOT_FOUND', 'INVALID_RECIPIENT', 'EMPTY_BODY',
  'BODY_TOO_LONG', 'REQUEST_ID_CONFLICT', 'PROCESSING_FAILED', 'INVALID_REPLY_TARGET', 'INVALID_FORWARD_SOURCE']);
export const pageSize = 50;
export const chatPath = id => '/chats/' + id;

export function orderedMessages(page, id, ordered = true) {
  check(Array.isArray(page?.messages) && page.messages.length <= 100);
  let last = '0';
  const ids = new Set();
  for (const message of page.messages) {
    check(message.chatId === id && isId(message.id) && isId(message.senderId) &&
      isSeq(message.sequence) && (!ordered || greater(message.sequence, last)) && isSeq(message.messageVersion) && !ids.has(message.id), 'invalidMessagePage');
    ids.add(message.id);
    last = message.sequence;
  }
  return page.messages;
}

function mergeMessages(before, after) {
  const unique = new Map(before.map(message => [message.id, message]));
  for (const message of after) unique.set(message.id, message);
  return [...unique.values()].sort((a, b) => greater(a.sequence, b.sequence) ? 1 : -1).slice(-150);
}

const windowOwner = view => Math.max(view.changesSelection, view.installedWindow?.selection ?? -1);
const recoveryState = (selection, view) => ({ selection, installation: view.installedWindow, remainingPages: 20, window: null, hasMore: false });

export class Device {
  // Sends without a terminal result, so reconciliation never scans the whole run.
  pendingSends = new Set();
  socket = null;
  selected = null;
  foreground = true;
  directory = [];
  views = new Map();
  roomCursors = new Map();
  summaries = new Map();
  // Delivery accounting uses these to tell misses from interruptions. `connection` changes when the socket
  // closes (direct chats arrive on the account room); `selection` also changes on a chat switch (group rooms).
  connection = 0;
  selection = 0;
  selectionEndedAt = new Map(); // selection -> when it ended, for the last 64 selections

  endSelection() {
    this.selectionEndedAt.set(this.selection, performance.now());
    if (this.selectionEndedAt.size > 64) this.selectionEndedAt.delete(this.selectionEndedAt.keys().next().value);
    this.selection++;
  }

  /** How long this device kept the given chat selection open after `since`. */
  stayedSelected(selection, since) {
    const ended = selection === this.selection ? performance.now() : this.selectionEndedAt.get(selection) ?? since;
    return ended - since;
  }
  subscribedTo = null;
  refreshes = new Map();
  watch = new Map();
  watchAfter = 0;
  phase = 'closed';
  connectionWork = Promise.resolve();
  sessionWork = Promise.resolve();
  connectionRevision = 0;
  appRevision = 0;

  constructor(state, credentials, actor) {
    Object.assign(this, { state, credentials, actor });
  }

  get connected() { return this.socket?.opened && this.socket.ws.readyState === WebSocket.OPEN; }

  get(path, args) {
    return this.state.http.request(this.credentials, args ? query(path, args) : path);
  }

  change(path, method, body) {
    return this.state.http.request(this.credentials, path, method, body);
  }

  recheckReads(id) {
    const view = this.view(id);
    view.readOwed = this.selection;
    if (view.readCheck) return view.readCheck;
    const owed = () => view.readOwed === this.selection && this.selected?.id === id;
    view.readCheck = this.backgroundTask('live.state/' + id, async () => {
      while (owed()) {
        const selection = view.readOwed;
        view.readOwed = null;
        try {
          await this.sync(id, { primary: true });
          view.readFailures = 0;
        } catch (error) {
          this.state.metrics.failure('live', error);
          if (++view.readFailures < 3 && view.readOwed === null) view.readOwed = selection;
          break;
        }
      }
    }).finally(() => {
      view.readCheck = null;
      if (owed() && !view.readRetry) {
        view.readRetry = setTimeout(() => {
          view.readRetry = null;
          if (owed()) this.recheckReads(id);
        }, 250);
        view.readRetry.unref?.();
      }
    });
    return view.readCheck;
  }

  backgroundTask(key, task) {
    if (this.refreshes.has(key)) return this.refreshes.get(key);
    if (this.state.background.size >= 256 * this.state.capacity) {
      this.state.metrics.failure(key.split('/')[0], new Fault('backgroundCapacity'));
      return Promise.resolve();
    }
    const work = Promise.resolve().then(task).catch(error => this.state.metrics.failure(key.split('/')[0], error)).finally(() => {
      this.refreshes.delete(key);
      this.state.background.delete(work);
    });
    this.refreshes.set(key, work);
    this.state.background.add(work);
    return work;
  }

  async refreshDirectory() {
    const result = await this.get('/chats', { limit: 100 });
    check(Array.isArray(result?.chats) && result.chats.length <= 100 && result.chats.every(chat => isId(chat.id)));
    this.directory = result.chats;
    return result.chats;
  }

  // Mirrors useMessengerSocket's refresh queue: chat ID -> sequence the row must reach (null: refresh regardless).
  summaryLater(id, jitter, sequence = null) {
    const queued = this.summaries.get(id);
    if (queued === undefined && this.summaries.size >= 100) return;
    if (queued === undefined) this.summaries.set(id, sequence);
    else if (queued === null || sequence === null) this.summaries.set(id, null);
    else if (greater(sequence, queued)) this.summaries.set(id, sequence);
    this.backgroundTask('sidebar.summary', async () => {
      while (this.summaries.size && this.phase !== 'closed') {
        await delay(jitter ? 700 + this.actor % 1300 : 500, undefined, { signal: this.state.signal });
        const batch = [...this.summaries].slice(0, 10);
        for (const [chat] of batch) this.summaries.delete(chat);
        await join(batch.map(async ([chat, wanted]) => {
          const row = this.directory.find(item => item.id === chat);
          if (wanted !== null && row && !greater(wanted, row.lastSequence)) return;
          try {
            this.state.metrics.count('sidebar.summaryFetched');
            this.replaceRow(await this.get(chatPath(chat)));
          } catch (error) {
            this.state.metrics.failure('sidebar.summary', error);
          }
        }));
      }
    });
  }

  replaceRow(chat) {
    check(isId(chat?.id) && isSeq(chat.lastSequence), 'invalidChat');
    this.directory = this.directory.map(row => row.id === chat.id ? { ...row, ...chat } : row);
  }

  // Mirrors useChatDirectory.applyActivity: show the next message locally, or report that the row needs a fetch.
  applyActivity(id, sequence, message) {
    const row = this.directory.find(item => item.id === id);
    if (!row || !greater(sequence, row.lastSequence)) return true;
    if (BigInt(row.lastSequence) + 1n !== BigInt(sequence)) return false;
    const fromOther = message.senderId !== this.credentials.userId;
    const unread = row.unreadCount ?? 0;
    if (fromOther && !row.unreadCountCapped && unread + 1 >= 256) return false;
    this.state.metrics.count('sidebar.appliedLocally');
    this.replaceRow({
      ...row, lastSequence: sequence, activityAt: message.createdAt,
      unreadCount: fromOther && !row.unreadCountCapped ? unread + 1 : unread,
      lastMessage: {
        id: message.messageId, sequence, senderId: message.senderId, senderUsername: message.senderUsername,
        createdAt: message.createdAt, bodyPreview: message.preview, deleted: false,
      },
    });
    return true;
  }

  activityMessage(frame) {
    if (frame.type === 'sidebar_activity') return frame.messageId ? frame : null;
    const sender = this.directory.find(row => row.id === frame.chatId)?.members?.find(member => member.id === frame.senderId);
    return sender ? { ...frame, senderUsername: sender.username, preview: [...frame.body].slice(0, 160).join('') } : null;
  }

  view(id) {
    if (!this.views.has(id)) {
      this.views.set(id, {
        messages: [], baseline: '0', dismissed: '0', loaded: false, reads: '0',
        mutation: '0', visibility: '0', member: '0', pins: '0', memberPins: '0', stateAt: null, readCheck: null, readOwed: null, readRetry: null, readFailures: 0, changesAfter: null, changesSelection: -1, installedWindow: null, ready: null, detached: null,
      });
    }
    return this.views.get(id);
  }

  send(frame) {
    this.socket?.send(frame);
  }

  requireSocket() {
    check(this.connected, 'socketUnavailable');
    return this.socket;
  }

  offerWatch(frame) {
    if (!this.connected) return;
    if (frame.type === 'unwatch_presence') {
      this.watch.delete('watch_presence');
      this.send(frame);
      return;
    }
    this.watch.set(frame.type, frame);
    this.backgroundTask('watch.flush', async () => {
      while (this.watch.size && this.connected) {
        const wait = this.watchAfter - performance.now();
        if (wait > 0) await delay(wait, undefined, { signal: this.state.signal });
        if (!this.connected || this.watch.size === 0) break;
        const [key, next] = this.watch.entries().next().value;
        this.watch.delete(key);
        this.watchAfter = performance.now() + 1500;
        this.send(next);
      }
    });
  }

  sidebar() {
    this.offerWatch({ type: 'watch_sidebar', chatIds: this.directory.slice(0, 14).map(chat => chat.id).sort() });
  }

  session(work) {
    const next = this.sessionWork.then(work);
    this.sessionWork = next.catch(() => {});
    return next;
  }

  connectionChange(work) {
    const next = this.connectionWork.then(work);
    this.connectionWork = next.catch(() => {});
    return next;
  }

  connect(revision = this.connectionRevision) {
    return this.connectionChange(async () => {
      check(revision === this.connectionRevision, 'socketClosed');
      if (this.socket) {
        this.connection++;
        this.endSelection();
        this.subscribedTo = null;
        this.watch.clear();
        await this.socket.close();
      }
      const socket = new Socket(this.state.http, this.credentials, frame => {
        if (this.socket === socket && revision === this.connectionRevision) this.onFrame(frame);
      });
      this.socket = socket;
      try {
        await socket.open();
        check(revision === this.connectionRevision, 'socketClosed');
      } catch (error) {
        await socket.close();
        if (this.socket === socket) this.socket = null;
        throw error;
      }
    });
  }

  disconnect() {
    this.connectionRevision++;
    this.connection++;
    this.endSelection();
    this.subscribedTo = null;
    this.watch.clear();
    return this.connectionChange(async () => {
      const socket = this.socket;
      await socket?.close();
      if (this.socket === socket) this.socket = null;
    });
  }

  async startup(restore, started, revision = this.connectionRevision) {
    check(revision === this.connectionRevision, 'socketClosed');
    this.phase = 'opening';
    this.foreground = true;
    if (restore) {
      const result = await this.get('/auth/session');
      check(result?.userId === this.credentials.userId && result.deviceId === this.credentials.deviceId, 'wrongSession');
    }
    await join([
      this.refreshDirectory().then(() => this.state.metrics.observe('appOpen.sidebarReady', performance.now() - started)),
      this.connect(revision),
    ]);
    check(revision === this.connectionRevision, 'socketClosed');
    this.phase = 'open';
    this.backgroundTask('sidebar.initial', async () => {
      await delay(250, undefined, { signal: this.state.signal });
      this.sidebar();
    });
  }

  async close() {
    this.phase = 'closed';
    this.selected = null;
    this.watch.clear();
    this.summaries.clear();
    await this.disconnect();
  }

  subscribe(chat) {
    if (!this.connected) return;
    const view = this.view(chat.id);
    if (view.dismissed !== '0') this.send({ type: 'dismissed', chatId: chat.id, sequence: view.dismissed });
    const room = chat.kind === 'GROUP' ? 'group:' + chat.id : 'user:' + this.credentials.userId;
    this.send({ type: 'subscribe_many', subscriptions: [{
      chatId: chat.id, kind: chat.kind, lastAppliedSequence: view.baseline, ...this.roomCursors.get(room),
    }] });
  }

  install(id, page, replace = false) {
    const view = this.view(id);
    const messages = orderedMessages(page, id);
    view.messages = replace ? messages : mergeMessages(view.messages, messages);
    return view;
  }

  async latest(id, protection = null) {
    const selection = this.selection;
    const page = await this.get(chatPath(id) + '/messages', { limit: pageSize });
    check(isSeq(page?.coverageThroughSequence) && isSeq(page?.mutationSeq) && isSeq(page?.visibilitySeq));
    const messages = orderedMessages(page, id);
    const view = this.view(id);
    if (protection && (protection.owner !== windowOwner(view) || protection.installed !== view.installedWindow)) return null;
    if (windowOwner(view) > selection || view.changesAfter !== null && (greater(view.mutation, page.coverageThroughSequence) || greater(view.visibility, page.visibilitySeq))) return null;
    const ahead = view.messages.filter(message => greater(message.sequence, page.coverageThroughSequence));
    view.messages = mergeMessages(messages, ahead);
    const installation = { selection };
    view.installedWindow = installation;
    if (greater(page.coverageThroughSequence, view.baseline)) {
      view.baseline = page.coverageThroughSequence;
      view.dismissed = view.baseline;
      if (this.connected) this.send({ type: 'dismissed', chatId: id, sequence: view.dismissed });
    }
    view.loaded = true;
    view.mutation = page.mutationSeq;
    view.visibility = page.visibilitySeq;
    for (const message of page.messages) this.state.recovered(this, message);
    if (this.selected?.id === id && this.selection === selection && view.changesAfter === null) {
      view.changesAfter = page.mutationSeq;
      view.changesSelection = selection;
      this.refreshChanges(id);
    }
    return installation;
  }

  catchUp(id, required = '0') {
    const view = this.view(id);
    if (greater(required, view.catchUpRequired ?? '0')) view.catchUpRequired = required;
    if (view.catchingUp) return view.catchingUp;
    const recovery = recoveryState(this.selection, view);
    const work = (async () => {
      try {
        await view.ready?.catch(() => {});
        do {
          const wanted = view.catchUpRequired ?? '0';
          await this.loadCatchUp(id, wanted, recovery);
          check(!greater(wanted, view.baseline), 'catchUpGap');
        } while (greater(view.catchUpRequired ?? '0', view.baseline) || this.selected?.id === id && view.changesAfter === null);
      } finally {
        if (view.catchingUp === work) view.catchingUp = null;
      }
    })();
    view.catchingUp = work;
    return view.catchingUp;
  }

  async protectWindow(id, recovery) {
    const view = this.view(id);
    if (windowOwner(view) <= recovery.selection && view.installedWindow === recovery.installation) return { owner: windowOwner(view), installed: view.installedWindow };
    const ready = view.ready;
    await ready?.catch(() => {});
    if (view.ready && view.ready !== ready) return false;
    if (view.installedWindow && view.installedWindow !== recovery.installation && recovery.window?.installation !== view.installedWindow) {
      recovery.window = { installation: view.installedWindow, ids: new Set(view.messages.map(message => message.id)) };
    }
    return { owner: windowOwner(view), installed: view.installedWindow };
  }

  async refreshSnapshot(id, required = '0', recovery = recoveryState(this.selection, this.view(id))) {
    const view = this.view(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const protection = await this.protectWindow(id, recovery);
      if (!protection || protection.owner !== windowOwner(view) || protection.installed !== view.installedWindow) continue;
      if (recovery.window) {
        if (!recovery.hasMore && !greater(required, view.baseline)) return;
        check(recovery.remainingPages > 0, 'catchUpGap');
        return this.catchUpPages(id, required, recovery);
      }
      const installation = await this.latest(id, protection);
      if (installation) {
        recovery.installation = installation;
        recovery.hasMore = false;
        return;
      }
      if (!recovery.hasMore && !greater(required, view.baseline)) return;
      check(recovery.remainingPages > 0 || protection.installed === view.installedWindow, 'catchUpGap');
    }
    throw new Fault('catchUpSnapshotStale');
  }

  async loadCatchUp(id, required, recovery = recoveryState(this.selection, this.view(id))) {
    const view = this.view(id);
    if (windowOwner(view) > recovery.selection || !view.loaded || view.detached || this.selected?.id === id && view.changesAfter === null) {
      await this.refreshSnapshot(id, required, recovery);
      return;
    }
    return this.catchUpPages(id, required, recovery);
  }

  async catchUpPages(id, required, recovery = recoveryState(this.selection, this.view(id))) {
    const view = this.view(id);
    const baseline = view.baseline;
    let afterSeq = baseline;
    while (recovery.remainingPages > 0) {
      let accepted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        let protection = await this.protectWindow(id, recovery);
        if (!protection || protection.owner !== windowOwner(view) || protection.installed !== view.installedWindow) continue;
        const page = await this.get(chatPath(id) + '/messages', { afterSeq, limit: pageSize });
        check(isSeq(page?.coverageThroughSequence) && isSeq(page?.nextSequence) && typeof page.hasMore === 'boolean');
        const messages = orderedMessages(page, id);
        protection = await this.protectWindow(id, recovery);
        if (!protection || protection.owner !== windowOwner(view) || protection.installed !== view.installedWindow) continue;
        if (recovery.window) {
          check(isSeq(page.snapshotSequence) && isSeq(page.visibilitySeq), 'invalidHistorySnapshot');
          if (greater(view.mutation, page.snapshotSequence) || greater(view.visibility, page.visibilitySeq)) continue;
        }
        const visible = recovery.window ? messages.filter(message => recovery.window.ids.has(message.id)) : messages;
        view.messages = mergeMessages(view.messages, visible);
        for (const message of messages) this.state.recovered(this, message);
        recovery.remainingPages--;
        recovery.hasMore = page.hasMore;
        if (greater(page.coverageThroughSequence, view.baseline)) view.baseline = page.coverageThroughSequence;
        if (!page.hasMore) {
          check(!greater(required, view.baseline), 'catchUpGap');
          if (this.connected && greater(view.baseline, baseline) && greater(view.baseline, view.dismissed)) {
            this.send({ type: 'applied', chatId: id, sequence: view.baseline });
          }
          return;
        }
        check(greater(page.nextSequence, afterSeq), 'catchUpCursor');
        afterSeq = page.nextSequence;
        accepted = true;
        break;
      }
      check(accepted, 'catchUpSnapshotStale');
    }
    await this.refreshSnapshot(id, required, recovery);
  }

  // Mirrors the browser: one /state check returns every counter the selected chat needs, and only the
  // parts whose counter moved are fetched.
  async sync(id, { primary = false, seen } = {}) {
    const view = this.view(id);
    view.stateAt = performance.now();
    const minSeq = seen && greater(seen, view.baseline) ? seen : view.baseline;
    const fresh = !primary && view.loaded ? { minSeq, minMemberSeq: view.member } : {};
    const current = await this.get(chatPath(id) + '/state', fresh);
    await view.ready?.catch(() => {});
    check(isSeq(current?.lastSeq) && isSeq(current.mutationSeq) && isSeq(current.memberSeq) && isSeq(current.visibilitySeq) &&
      isSeq(current.pinsSeq) && isSeq(current.memberPinsSeq) &&
      isSeq(current.ownReadThrough) && isSeq(current.otherReadThrough), 'invalidState');
    if (this.selected?.id === id && view.changesAfter === null) await this.catchUp(id, current.lastSeq);
    if (greater(current.ownReadThrough, view.reads)) view.reads = current.ownReadThrough;
    this.state.readNotification(this, id, { throughSequence: current.ownReadThrough, maxOtherReadSequence: current.otherReadThrough });
    if (greater(current.memberSeq, view.member)) view.member = current.memberSeq;
    if (greater(current.pinsSeq, view.pins) || greater(current.memberPinsSeq, view.memberPins)) {
      view.pins = current.pinsSeq;
      view.memberPins = current.memberPinsSeq;
      await this.get(chatPath(id) + '/pins', { limit: 50 });
    }
    if (greater(current.mutationSeq, view.mutation) && view.changesAfter !== null) await this.refreshChanges(id);
    if (greater(current.visibilitySeq, view.visibility)) {
      const ids = view.messages.map(message => message.id);
      for (let i = 0; i < ids.length; i += 100) {
        const messageIds = ids.slice(i, i + 100);
        const result = await this.change(chatPath(id) + '/messages/resolve', 'POST', { messageIds });
        const fresh = orderedMessages(result, id, false).sort((a, b) => greater(a.sequence, b.sequence) ? 1 : -1);
        view.messages = view.messages.filter(message => !messageIds.includes(message.id));
        this.install(id, { messages: fresh });
      }
      view.visibility = current.visibilitySeq;
      await this.refreshSnapshot(id, current.lastSeq);
    } else if (!view.loaded || greater(current.lastSeq, view.baseline)) {
      await this.catchUp(id, current.lastSeq);
    }
  }

  refreshChanges(id) {
    const selection = this.selection;
    const view = this.view(id);
    if (view.changesAfter === null || this.selected?.id !== id) return;
    return this.backgroundTask('live.changes/' + id + '/' + selection, async () => {
      let afterSeq = view.changesAfter;
      for (let n = 0; n < 10 && afterSeq !== null && this.selected?.id === id && this.selection === selection; n++) {
        const page = await this.get(chatPath(id) + '/messages/changes', { afterSeq, limit: 100 });
        this.state.metrics.count('changes.pages');
        if (this.selected?.id !== id || this.selection !== selection || view.changesAfter === null) return;
        check(isSeq(page?.lastSeq) && isSeq(page.nextSeq) && typeof page.resetRequired === 'boolean' &&
          Array.isArray(page.changes) && page.changes.length <= 100, 'invalidChanges');
        if (page.resetRequired) break;
        check(!greater(afterSeq, page.nextSeq) && !greater(page.nextSeq, page.lastSeq) &&
          (page.nextSeq !== afterSeq || page.nextSeq === page.lastSeq), 'changesCursor');
        let previous = afterSeq;
        for (const change of page.changes) {
          check(isSeq(change.seq) && !greater(previous, change.seq) &&
            !greater(change.seq, page.nextSeq), 'invalidChangeSeq');
          previous = change.seq;
          if (change.kind === 'UPSERT') {
            const [message] = orderedMessages({ messages: [change.message] }, id);
            check(message.id === change.messageId && message.sequence === change.sequence, 'invalidUpsert');
            view.messages = view.messages.map(old =>
              old.id === message.id && greater(message.messageVersion, old.messageVersion) ? message : old);
          } else if (change.kind === 'REMOVED') {
            check(isId(change.messageId) && isSeq(change.sequence), 'invalidRemoval');
            view.messages = view.messages.filter(message => message.id !== change.messageId);
          } else {
            check(change.kind === 'CLEARED' && isSeq(change.clearedThroughSequence), 'invalidClear');
            view.messages = view.messages.filter(message => greater(message.sequence, change.clearedThroughSequence));
          }
        }
        afterSeq = page.nextSeq;
        view.changesAfter = afterSeq;
        view.changesSelection = selection;
        if (greater(afterSeq, view.mutation)) view.mutation = afterSeq;
        if (afterSeq === page.lastSeq) return;
      }
      if (this.selected?.id !== id || this.selection !== selection) return;
      const installed = await this.latest(id);
      if (installed && this.selected?.id === id && this.selection === selection) {
        view.changesAfter = view.mutation;
        view.changesSelection = selection;
      }
    });
  }

  async refreshFeatures(chat, force = false) {
    if (!chat || !this.connected) return;
    if (chat.members.length === 0) {
      const details = await this.get(chatPath(chat.id));
      check(details?.id === chat.id && Array.isArray(details.members), 'invalidChatMembers');
      chat.members = details.members;
      if (this.selected?.id === chat.id && chat.members.length) this.offerWatch({ type: 'unwatch_presence' });
    }
    if (chat.members.length && this.selected?.id === chat.id) this.offerWatch({
      type: 'watch_presence', chatId: chat.id,
      userIds: chat.members.slice(0, 100).map(member => member.id).sort(),
    });
    if (force || this.view(chat.id).stateAt === null || performance.now() - this.view(chat.id).stateAt >= STATE_CHECK_MS) await this.sync(chat.id);
  }

  async openChat(chat, started) {
    if (this.selected?.id === chat.id && (this.view(chat.id).ready || this.view(chat.id).changesAfter !== null)) {
      await this.view(chat.id).ready;
      this.state.metrics.observe('chatOpen.firstPageReady', performance.now() - started);
      return;
    }
    this.endSelection();
    this.subscribedTo = null;
    if (this.selected && this.connected) {
      this.offerWatch({ type: 'unwatch_presence' });
      this.send({ type: 'unsubscribe', chatId: this.selected.id });
    }
    this.selected = chat;
    this.subscribe(chat);
    const view = this.view(chat.id);
    view.changesAfter = null;
    const selection = this.selection;
    view.changesSelection = selection;
    const ready = (async () => {
      try {
        if (view.detached) {
          const anchor = view.detached;
          await this.around(chat.id, anchor, true);
        } else await this.latest(chat.id);
        this.state.metrics.observe('chatOpen.firstPageReady', performance.now() - started);
        if (this.selected?.id === chat.id && this.selection === selection && view.changesAfter === null) {
          view.changesAfter = view.mutation;
          view.changesSelection = selection;
          this.refreshChanges(chat.id);
        }
      } finally {
        if (view.ready === ready) view.ready = null;
      }
    })();
    view.ready = ready;
    const features = this.refreshFeatures(chat, true);
    const unread = chat.markedUnread || this.directory.find(row => row.id === chat.id)?.markedUnread;
    await join([ready, features, ...(unread ? [
      this.change(chatPath(chat.id) + '/unread-mark', 'DELETE'),
    ] : [])]);
  }

  async around(id, anchor, restoring = false) {
    const selection = this.selection;
    const result = await this.get(chatPath(id) + '/messages/around', {
      messageId: anchor.id, ...(restoring ? { anchorSequence: anchor.sequence } : {}), limit: pageSize,
    });
    check(isSeq(result?.mutationSeq), 'invalidAround');
    const view = this.view(id);
    if (windowOwner(view) > selection) return;
    this.install(id, result, true);
    view.installedWindow = { selection };
    if (greater(result.mutationSeq, view.mutation)) view.mutation = result.mutationSeq;
    view.detached = view.messages.find(message => message.id === result.anchorMessageId) ?? anchor;
  }

  async reconcile() {
    const incomplete = [...this.pendingSends].filter(record => !record.saved && !record.rejected);
    if (!incomplete.length) return;
    const result = await this.change('/sends/status', 'POST', { requestIds: incomplete.slice(0, 100).map(send => send.requestId) });
    check(Array.isArray(result?.results) && result.results.length <= 100);
    for (const row of result.results) {
      const record = this.state.sends.get(row.requestId);
      if (record?.device !== this) continue;
      if (row.result?.status === 'SAVED') this.state.saved(record, row.result, false);
      if (row.result?.status === 'REJECTED') record.finish(null, 'rejectedByStatus');
    }
  }

  onFrame(frame) {
    if (this.state.acceptingEvents === false) return;
    const { metrics } = this.state;
    const { type, chatId } = frame;
    metrics.count('frame.' + type);
    if (type === 'message_saved' || type === 'sidebar_activity') {
      const message = this.activityMessage(frame);
      if (!message || !this.applyActivity(chatId, frame.sequence, message)) this.summaryLater(chatId, type === 'sidebar_activity', frame.sequence);
    } else if (type === 'message_changed' || type === 'history_changed' ||
        (type === 'reads_changed' && frame.memberSeq !== undefined)) {
      this.summaryLater(chatId, false);
    } else if (type === 'chat_preferences_changed') {
      if (this.directory.some(row => row.id === chatId)) this.summaryLater(chatId, false);
      else this.backgroundTask('sidebar.directory', () => this.refreshDirectory());
    }
    if (['history_changed', 'chat_created', 'membership_changed', 'member_removed'].includes(type)) {
      this.backgroundTask('sidebar.directory', () => this.refreshDirectory());
    }
    if (type === 'message_saved') {
      this.state.notification(this, frame);
      const view = this.view(chatId);
      if (greater(frame.sequence, view.dismissed) && BigInt(frame.sequence) === BigInt(view.baseline) + 1n) {
        view.baseline = frame.sequence;
        this.install(chatId, { messages: [{ ...frame, id: frame.messageId }] });
      }
      if (greater(frame.sequence, view.dismissed) && !greater(frame.sequence, view.baseline)) {
        const cursor = frame.epoch && frame.streamId && frame.room ? { epoch: frame.epoch, streamId: frame.streamId } : {};
        if (cursor.epoch) this.roomCursors.set(frame.room, cursor);
        this.send({ type: 'applied', chatId, sequence: view.baseline, ...cursor });
      } else {
        this.send({ type: 'received_message', chatId, sequence: frame.sequence });
        if (this.selected?.id === chatId && greater(frame.sequence, view.baseline) && view.loaded) {
          this.backgroundTask('live.catchUp/' + chatId, async () => {
            await delay(1250, undefined, { signal: this.state.signal });
            if (this.selected?.id === chatId && greater(frame.sequence, view.baseline)) await this.sync(chatId, { seen: frame.sequence });
          });
        }
      }
    } else if (type === 'subscribed' && this.selected?.id === chatId) {
      this.subscribedTo = chatId;
    } else if (type === 'reads_changed' && this.selected?.id === chatId) {
      this.recheckReads(chatId);
    } else if (type === 'message_changed' || type === 'history_changed') {
      this.backgroundTask('live.visibility/' + chatId, () => this.sync(chatId));
    } else if (type === 'pins_changed' && this.selected?.id === chatId) {
      this.backgroundTask('live.pins/' + chatId, async () => {
        await delay(250, undefined, { signal: this.state.signal });
        await this.get(chatPath(chatId) + '/pins', { limit: 50 });
      });
    } else if (type === 'recovery_failed') {
      this.backgroundTask('live.recovery/' + chatId, () => join([this.selected?.id === chatId ? this.sync(chatId, { primary: true }) : this.catchUp(chatId), this.reconcile()]));
    } else if (type === 'subscription_expired' && this.selected?.id === chatId) {
      this.subscribe(this.selected);
    } else if ((type === 'send_rejected' || type === 'error') && frame.requestId) {
      const record = this.state.sends.get(frame.requestId);
      if (record?.device === this) {
        const code = type === 'error' ? frame.code : frame.reason;
        if (code !== 'PUBLISH_UNKNOWN') record.finish(null, statusCodes.has(code) || rejections.has(code) ? code : 'sendRejected');
      }
    } else if (type === 'error') {
      metrics.failure('socket.server', new Fault(statusCodes.has(frame.code) ? frame.code : 'socketError'));
    }
  }
}
