const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LEGACY_SIDEBAR_LIMIT = 100;

export const DEFAULTS = Object.freeze({
  seed: 1118, users: 16384, degree: 50, hotSubjects: 4, hotFollowers: 1400, hotPool: 3500,
  groupSize: 64, groupCohortEvery: 5,
});

export function random(seed) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const result = (t + d) | 0;
    c = (c + result) | 0;
    return (result >>> 0) / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();
  return next;
}

export function shuffle(values, rand) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function id(kind, index, rand) {
  let value = '01' + kind;
  for (let i = 0; i < 9; i++) value += CROCKFORD[Math.floor(rand() * 32)];
  let suffix = '';
  for (let i = 0, n = index; i < 14; i++, n = Math.floor(n / 32)) suffix = CROCKFORD[n % 32] + suffix;
  return value + suffix;
}

export function buildPlan(options = {}) {
  const p = { ...DEFAULTS, ...options };
  if (p.degree % 2 || p.degree < 2) throw new Error('degree must be an even number of at least 2');
  if (p.users < p.groupSize * 2 || p.users % p.groupSize) throw new Error('users must be a multiple of groupSize, with at least two groups');
  const rand = random(p.seed);
  const users = Array.from({ length: p.users }, (_, i) => ({ id: id('S', i, rand), username: 'pl' + i }));
  const order = shuffle([...users.keys()], rand);
  const position = new Int32Array(p.users);
  order.forEach((user, k) => { position[user] = k; });

  const peers = users.map(() => []);
  const edges = new Set();
  const directs = [];
  const connect = (a, b, limited = [a, b]) => {
    if (a === b) return false;
    const key = Math.min(a, b) * p.users + Math.max(a, b);
    if (edges.has(key) || limited.some(user => peers[user].length >= LEGACY_SIDEBAR_LIMIT)) return false;
    edges.add(key);
    const [low, high] = users[a].id < users[b].id ? [a, b] : [b, a];
    const chat = { id: id('D', directs.length, rand), low, high };
    directs.push(chat);
    peers[a].push({ peer: b, chat: chat.id });
    peers[b].push({ peer: a, chat: chat.id });
    return true;
  };
  for (let round = 0; round < p.degree / 2; round++) {
    const target = shuffle([...users.keys()], rand);
    for (let a = 0; a < p.users; a++) connect(a, target[a]);
  }

  const hot = order.slice(0, p.hotSubjects);
  const pool = order.slice(p.hotSubjects, Math.min(p.hotPool, p.users));
  for (const subject of hot) {
    let added = 0;
    for (const follower of shuffle([...pool], rand)) {
      if (added >= p.hotFollowers) break;
      if (connect(subject, follower, [follower])) added++;
    }
  }

  const groups = [];
  const groupOf = new Int32Array(p.users);
  for (let start = 0; start < p.users; start += p.groupSize) {
    const members = order.slice(start, start + p.groupSize);
    const group = { id: id('G', groups.length, rand), name: 'Presence load ' + groups.length, owner: members[0], members };
    for (const member of members) groupOf[member] = groups.length;
    groups.push(group);
  }

  return {
    params: p, users, order, position, peers, directs, groups, groupOf, hot,
    openGroup: user => position[user] % p.groupCohortEvery === 0 ? groups[groupOf[user]] : null,
  };
}

export function watchSet(plan, user) {
  const group = plan.openGroup(user);
  const direct = plan.peers[user].slice(0, LEGACY_SIDEBAR_LIMIT);
  const subjects = new Set(direct.map(entry => entry.peer));
  const groupMembers = group ? group.members.filter(member => member !== user) : [];
  for (const member of groupMembers) subjects.add(member);
  return { directChats: direct.map(entry => entry.chat), group, groupMembers, subjects: [...subjects] };
}
