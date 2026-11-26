export const isId = value => typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
export const MAX_PRESENCE_TARGETS = 500;

const SNAPSHOT_SAMPLE = 3;
const SNAPSHOT_TIMEOUT_MS = 5000;
const UNWATCH_GRACE_MS = 1000;

const dateTime = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const lastSeenBuckets = new Set(['recently', 'within_week', 'within_month', 'long_ago']);
const fields = (value, allowed) => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isWatched = (id, watched) => isId(id) && watched?.has(id);

function validDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = dateTime.exec(value);
  return Boolean(match && Number.isFinite(Date.parse(value)) && new Date(match[1]).toISOString().startsWith(match[1]));
}

function validStatus(status, watched) {
  if (!fields(status, ['userId', 'online', 'lastSeenAt', 'lastSeen']) ||
      !isWatched(status.userId, watched) || typeof status.online !== 'boolean') return false;
  if (Object.hasOwn(status, 'lastSeenAt')) return !Object.hasOwn(status, 'lastSeen') && validDateTime(status.lastSeenAt);
  return !Object.hasOwn(status, 'lastSeen') || lastSeenBuckets.has(status.lastSeen);
}

export function validPresence(frame, watched) {
  if (frame?.type !== 'presence' || frame.version !== 1 || !fields(frame, ['type', 'version', 'statuses', 'unavailable']) ||
      !Array.isArray(frame.statuses) || frame.statuses.length > MAX_PRESENCE_TARGETS ||
      !frame.statuses.every(status => validStatus(status, watched))) return false;
  if (!Object.hasOwn(frame, 'unavailable')) return true;
  const { unavailable } = frame;
  return Array.isArray(unavailable) && unavailable.length <= MAX_PRESENCE_TARGETS &&
    unavailable.every(id => isWatched(id, watched)) && new Set(unavailable).size === unavailable.length;
}

export function validOnlineCount(frame) {
  return frame?.type === 'online_count' && frame.version === 1 && fields(frame, ['type', 'version', 'chatId', 'online', 'members']) &&
    isId(frame.chatId) && integer(frame.members, 1, 200) && integer(frame.online, 0, frame.members);
}

export function validPresenceConfig(frame) {
  return frame?.type === 'presence_config' && frame.version === 1 && fields(frame, ['type', 'version', 'idleAfterHiddenMs', 'idleAfterInputMs', 'releaseAfterHiddenMs']) &&
    integer(frame.idleAfterHiddenMs, 0, 3600000) && integer(frame.idleAfterInputMs, 1000, 3600000) &&
    integer(frame.releaseAfterHiddenMs, 1000, 86400000);
}

export class PresenceWatch {
  targets = new Map();
  removed = new Map();
  visible = true;
  pending = null;
  sampled = false;
  initialized = false;

  constructor(count, missing) {
    Object.assign(this, { count, missing });
  }

  sent(frame, now = performance.now()) {
    if (frame.type === 'activity') {
      this.visible = frame.visible;
      this.scheduleSnapshotCheck();
    } else if (frame.type === 'watch_online_count') {
      this.count('presence.onlineCountWatchFrames');
    } else if (frame.type === 'watch_presence') {
      this.initialized = true;
      this.count('presence.watchFrames');
      for (const [id, expires] of this.removed) {
        if (expires <= now) this.removed.delete(id);
      }
      const add = new Set(frame.add);
      for (const id of frame.reset ? this.targets.keys() : frame.remove ?? []) {
        if (!this.targets.delete(id)) continue;
        if (!add.has(id)) {
          this.removed.set(id, now + UNWATCH_GRACE_MS);
          this.pending?.delete(id);
        }
      }
      for (const id of add) {
        this.removed.delete(id);
        if (!this.targets.has(id)) this.targets.set(id, undefined);
      }
      if (!this.sampled && add.size) {
        this.sampled = true;
        this.pending = new Set([...add].slice(0, SNAPSHOT_SAMPLE));
        this.count('presence.snapshotChecks');
        this.scheduleSnapshotCheck();
      } else if (this.pending?.size === 0) {
        this.finishSnapshot('snapshotDeferred');
      }
    }
  }

  receive(frame, now = performance.now()) {
    if (frame.type === 'online_count') {
      this.count('presence.onlineCountFrames');
    } else if (frame.type === 'error' && frame.code === 'RATE_LIMITED') {
      this.count(frame.requestId ? 'socket.rateLimitErrorsWithRequest' : 'socket.rateLimitErrorsWithoutRequest');
    } else if (frame.type === 'presence') {
      if (!validPresence(frame, { has: id => this.targets.has(id) || this.removed.get(id) > now })) return false;
      this.count('presence.frames');
      for (const { userId, online, lastSeen } of frame.statuses) {
        if (!this.targets.has(userId)) continue;
        const prior = this.targets.get(userId);
        this.targets.set(userId, lastSeen === undefined ? online : undefined);
        if (lastSeen === undefined && prior !== undefined && prior !== online) {
          this.count('presence.transitions');
        }
        if (this.pending?.delete(userId) && this.pending.size === 0) this.finishSnapshot('snapshotPassed');
      }
      for (const id of frame.unavailable ?? []) {
        if (this.targets.has(id)) this.targets.set(id, undefined);
      }
    }
    return true;
  }

  scheduleSnapshotCheck() {
    clearTimeout(this.timer);
    if (!this.visible || !this.pending) return;
    this.timer = setTimeout(() => this.finishSnapshot('snapshotMissing'), SNAPSHOT_TIMEOUT_MS);
    this.timer.unref();
  }

  finishSnapshot(outcome) {
    if (!this.pending) return;
    clearTimeout(this.timer);
    this.pending = null;
    this.count('presence.' + outcome);
    if (outcome === 'snapshotMissing') this.missing();
  }

  finish() {
    this.finishSnapshot(this.visible ? 'snapshotMissing' : 'snapshotDeferred');
  }
}
