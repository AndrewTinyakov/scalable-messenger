export const isId = value => typeof value === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
export const MAX_PRESENCE_TARGETS = 500;

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
