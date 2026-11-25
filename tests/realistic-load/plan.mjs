// Builds the whole workload from a profile and a seed, without network or clock access.
// The same inputs always produce the same plan, so every run offers identical client behavior.

const FORMAT = 'messenger-realistic-load-v1';
const LIMITS = { users: 10_000, fixtureMessages: 1_000_000, actions: 1_000_000, sends: 200_000, sendsPerSecond: 1000 };

// Offsets in milliseconds, taken from how the browser client behaves around one chat visit.
const CLIENT = {
  firstVisitAfterOpen: 1700,
  readDwell: 1250, // 700 ms visible dwell plus rendering and the read debounce
  scrollAfter: 2200,
  preferencesAfter: 2900,
  jumpAfter: 3300,
  firstSendAfter: 3500, // time to read the chat and type a short reply
  forwardAfter: 4300,
  sendGap: [1000, 3300],
  mutationAfterSend: 3100,
  readersAfterSend: 3300,
  sidebarRenewal: [20000, 23000],
  featureRenewal: [12000, 15000],
  background: { after: 6800, length: 3900, minimumVisit: 12000 },
  blip: { after: 5600, length: 2400, minimumRemaining: 8500 },
  visit: { min: 5000, max: 60000, gap: [400, 1300], minimumUsable: 3500 },
  session: { min: 12000, rareActionGap: 1100, finalAppClose: 600 },
};

const ACTION_RATES = ['scroll', 'jump', 'background', 'blip', 'reply', 'mutation', 'readers', 'forward',
  'pinMessage', 'mute', 'pinChat', 'unread', 'sessions', 'lookup', 'direct', 'group', 'relogin'];
const PERSONAS = ['lurker', 'casual', 'active', 'power'];

function random(seed) {
  let state = seed >>> 0;
  const next = () => { // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    chance: probability => next() < probability,
    between: (min, max) => min + next() * (max - min),
    integer: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: items => items[Math.floor(next() * items.length)],
    lognormal: (median, spread) =>
      median * Math.exp(spread * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())),
    weighted: weights => {
      let point = next() * weights.reduce((a, b) => a + b);
      return weights.findIndex(weight => (point -= weight) < 0);
    },
    shuffle: source => {
      const items = [...source];
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
  });
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const pairKey = (a, b) => (a < b ? a + '/' + b : b + '/' + a);

// Gives exactly round(share * count) items to each index, then shuffles who gets which.
function distribute(rng, count, shares) {
  const quotas = shares.map(share => share * count);
  const sizes = quotas.map(Math.floor);
  const remaining = count - sizes.reduce((a, b) => a + b, 0);
  const byRemainder = quotas.map((quota, index) => [quota - sizes[index], index]).sort((a, b) => b[0] - a[0]);
  for (const [, index] of byRemainder.slice(0, remaining)) sizes[index]++;
  return rng.shuffle(sizes.flatMap((size, index) => Array(size).fill(index)));
}

export function validateProfile(profile, seed) {
  const { name, users, durationMs, personas, devicesPerUser, graph, history, timing, rates, text, ramp } = profile;
  const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
  const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  const shares = values => values.every(probability) && Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-6;
  const sizes = (list, max) => Array.isArray(list) && list.length <= max &&
    list.every(size => integer(size.min, 3, 1000) && integer(size.max, size.min, 1000));
  const checks = {
    seed: integer(seed, 0, 0xffffffff),
    name: /^[a-z0-9-]{1,40}$/.test(name),
    users: integer(users, 8, LIMITS.users),
    durationMs: integer(durationMs, 30000, 3600000),
    personas: Array.isArray(personas) && personas.map(persona => persona.name).join() === PERSONAS.join() &&
      shares(personas.map(persona => persona.share)) &&
      personas.every(persona => integer(persona.sessions, 1, 10) && integer(persona.sessionMedianMs, 1000, 3600000) &&
        integer(persona.visitMedianMs, 1000, 60000) && probability(persona.sendChance) &&
        integer(persona.burst, 0, 12) && integer(persona.favoriteChats, 1, 100)),
    devicesPerUser: Array.isArray(devicesPerUser) && devicesPerUser.length === 3 && shares(devicesPerUser),
    'graph.clusterSize': integer(graph?.clusterSize, 4, 40),
    'graph.directDegree': integer(graph?.directDegree, 1, 3),
    'graph.groupsPerUser': probability(graph?.groupsPerUser),
    'graph.groupSizes': sizes(graph?.groupSizes, 20) && shares(graph.groupSizes.map(size => size.share)),
    'graph.largeGroups': sizes(graph?.largeGroups, 20),
    history: integer(history?.min, 4, 256) && integer(history.max, history.min, 256),
    timing: probability(timing?.sessionSpread) && probability(timing.visitSpread) && probability(timing.secondaryUse) &&
      integer(timing.replyMinMs, 1000, 60000) && integer(timing.replyMaxMs, timing.replyMinMs, 120000) &&
      integer(timing.lagLimitMs, 1, 60000),
    rates: ACTION_RATES.every(key => probability(rates?.[key])) && rates.reply <= .5,
    text: integer(text?.median, 3, 4000) && Number.isFinite(text.spread) && text.spread >= 0 && text.spread <= 4,
    // Each stage adds users who join at its start. The last stage includes everyone, and joins leave two minutes of traffic.
    ramp: ramp === undefined || (integer(ramp.periodMs, 60000, 3600000) && Array.isArray(ramp.stages) &&
      ramp.stages.length >= 2 && ramp.stages.length <= 20 && ramp.stages[0].atMs === 0 &&
      ramp.stages.at(-1).users === users && ramp.stages.every((stage, i) => integer(stage.users, 8, users) &&
        integer(stage.atMs, 0, durationMs - 120000) &&
        (i === 0 || (stage.atMs > ramp.stages[i - 1].atMs && stage.users > ramp.stages[i - 1].users)))),
  };
  const invalid = Object.keys(checks).filter(key => !checks[key]);
  if (invalid.length) throw new Error('Invalid profile: ' + invalid.join(', '));
}

function planPopulation(rng, { users, personas, devicesPerUser }) {
  const personaOf = distribute(rng, users, personas.map(persona => persona.share));
  const devicesOf = distribute(rng, users, devicesPerUser);
  return Array.from({ length: users }, (_, id) => ({
    id, persona: personas[personaOf[id]].name, devices: devicesOf[id] + 1,
  }));
}

// Friends form clusters. Direct chats join cluster neighbours, small groups mostly stay inside one cluster,
// and the large groups span everyone.
function planChats(rng, population, { graph, history, text }) {
  const everyone = rng.shuffle(population.map(user => user.id));
  const clusters = [];
  for (let i = 0; i < everyone.length; i += graph.clusterSize) clusters.push(everyone.slice(i, i + graph.clusterSize));
  if (clusters.length > 1 && clusters.at(-1).length < 4) clusters.at(-2).push(...clusters.pop());

  const chats = [];
  const directPairs = new Set();
  let fixtureMessages = 0;
  const addChat = (kind, members) => {
    const length = Math.floor(history.min + rng() ** 2 * (history.max - history.min + 1));
    fixtureMessages += length;
    if (fixtureMessages > LIMITS.fixtureMessages) throw new Error('Plan exceeds the fixture message limit');
    const messages = Array.from({ length }, () => ({
      actor: rng.pick(members),
      bytes: Math.round(clamp(rng.lognormal(text.median, text.spread), 12, 4000)),
      textSeed: Math.floor(rng() * 0x100000000),
    }));
    if (kind === 'DIRECT') messages[0].actor = members[0]; // setup sends the first direct message live
    messages.at(-1).replyTo = Math.min(4, Math.floor(length / 4)); // a quote that jumps beyond the first page
    chats.push({ id: chats.length, kind, members, history: messages });
  };

  for (const cluster of clusters) {
    for (const [index, actor] of cluster.entries()) {
      for (let offset = 1; offset <= graph.directDegree; offset++) {
        const peer = cluster[(index + offset) % cluster.length];
        if (directPairs.has(pairKey(actor, peer))) continue;
        directPairs.add(pairKey(actor, peer));
        addChat('DIRECT', [actor, peer]);
      }
    }
  }
  for (let i = 0; i < Math.ceil(population.length * graph.groupsPerUser); i++) {
    const cluster = rng.pick(clusters);
    const { min, max } = graph.groupSizes[rng.weighted(graph.groupSizes.map(size => size.share))];
    const size = Math.min(population.length, rng.integer(min, max));
    addChat('GROUP', rng.shuffle(size <= cluster.length ? cluster : everyone).slice(0, size));
  }
  for (const { min, max } of graph.largeGroups) {
    addChat('GROUP', rng.shuffle(everyone).slice(0, Math.min(population.length, rng.integer(min, max))));
  }
  return { chats, directPairs, everyone };
}

class Planner {
  actions = [];
  sessions = [];
  deleted = new Set();

  constructor(rng, profile, population, chats) {
    Object.assign(this, { rng, profile, population, chats });
    this.visits = chats.map(() => []);
    this.memberships = population.map(() => []);
    for (const chat of chats) for (const actor of chat.members) this.memberships[actor].push(chat.id);
  }

  offer(session, at, type, data = {}) {
    if (this.actions.length >= LIMITS.actions) throw new Error('Plan exceeds the action limit');
    const id = this.actions.length;
    this.actions.push({
      id, at: Math.round(at), actor: session.actor, device: session.device, session: session.id,
      persona: this.population[session.actor].persona, chat: null, type, ...data,
    });
    return id;
  }

  send(session, at, chat, data) {
    const { text } = this.profile;
    return this.offer(session, at, 'send', {
      chat, bytes: Math.round(clamp(this.rng.lognormal(text.median, text.spread), 3, 4000)),
      textSeed: Math.floor(this.rng() * 0x100000000), ...data,
    });
  }

  // Each device gets its sessions spread over the run. Only one session per device is open at a time.
  planUser(user, persona, directPairs, everyone) {
    const { rng, profile: { durationMs, timing, ramp } } = this;
    const chats = rng.shuffle(this.memberships[user.id]);
    const favorites = chats.slice(0, persona.favoriteChats);
    // In a ramp, persona session counts are per ramp period, so a user's activity rate doesn't depend on when they join.
    const joined = ramp ? ramp.stages.find(stage => user.id < stage.users).atMs : 0;
    const window = durationMs - joined;
    const sessions = expected => {
      const whole = Math.floor(expected);
      return whole + Number(rng.chance(expected - whole));
    };
    for (let device = 0; device < user.devices; device++) {
      const count = !ramp ? (device === 0 ? persona.sessions : Number(rng.chance(timing.secondaryUse)))
        : sessions((device === 0 ? persona.sessions : timing.secondaryUse) * window / ramp.periodMs);
      const slot = window / count;
      for (let i = 0; i < count; i++) {
        const latestStart = Math.min(slot * .65, slot - Math.min(1000, slot / 3), window - 18000);
        const start = Math.round(joined + i * slot + rng() * latestStart);
        const length = clamp(rng.lognormal(persona.sessionMedianMs, timing.sessionSpread), CLIENT.session.min, slot * .75);
        const end = Math.min(joined + Math.floor((i + 1) * slot) - 50, start + Math.round(length));
        const session = { id: this.sessions.length, actor: user.id, device, start, end };
        this.sessions.push(session);
        this.planSession(session, persona, { chats, favorites }, directPairs, everyone);
      }
    }
  }

  planSession(session, persona, { chats, favorites }, directPairs, everyone) {
    const { rng, profile: { rates } } = this;
    this.offer(session, session.start, 'appOpen');
    for (let at = session.start + 250 + rng.between(...CLIENT.sidebarRenewal); at < session.end;
      at += rng.between(...CLIENT.sidebarRenewal)) {
      this.offer(session, at, 'sidebar');
    }

    // Rare account and directory actions happen one after another near the end of the session.
    const others = rng.shuffle(everyone.filter(id => id !== session.actor));
    const stranger = others.find(peer => !directPairs.has(pairKey(session.actor, peer)));
    const rare = [];
    if (rng.chance(rates.sessions)) rare.push(['sessions']);
    if (rng.chance(rates.lookup)) rare.push(['lookup', { peer: others[0] }]);
    if (stranger !== undefined && rng.chance(rates.direct)) {
      directPairs.add(pairKey(session.actor, stranger));
      rare.push(['direct', { peer: stranger, bytes: 32, textSeed: session.id }]);
    }
    if (persona.admin && rng.chance(rates.group)) rare.push(['group', { peers: others.slice(0, 3) }]);
    if (rng.chance(rates.relogin)) rare.push(['logout'], ['login']);
    const rareStart = session.end - CLIENT.session.finalAppClose - (rare.length + 2) * CLIENT.session.rareActionGap;

    let at = session.start + CLIENT.firstVisitAfterOpen;
    while (at + CLIENT.visit.minimumUsable < rareStart) {
      const chat = rng.pick(rng.chance(.8) ? favorites : chats);
      const length = clamp(rng.lognormal(persona.visitMedianMs, this.profile.timing.visitSpread), CLIENT.visit.min, CLIENT.visit.max);
      const until = Math.min(rareStart - 100, at + length);
      if (until - at < CLIENT.visit.minimumUsable) break;
      this.planVisit(session, persona, chat, chats, at, until);
      at = until + rng.between(...CLIENT.visit.gap);
    }
    rare.forEach(([type, data], index) => this.offer(session, rareStart + (index + 1) * CLIENT.session.rareActionGap, type, data));
    this.offer(session, session.end, 'appClose');
  }

  planVisit(session, persona, chat, chats, at, until) {
    const { rng, profile: { rates } } = this;
    this.offer(session, at, 'chatOpen', { chat });
    this.offer(session, at + CLIENT.readDwell, 'read', { chat });
    if (rng.chance(rates.scroll)) this.offer(session, at + CLIENT.scrollAfter, 'scroll', { chat });
    if (rng.chance(rates.jump)) this.offer(session, at + CLIENT.jumpAfter, 'jump', { chat, reference: { quotedBack: 1 } });

    // While the app is in the background or offline, the user can't read or send.
    let away = null;
    if (until - at > CLIENT.background.minimumVisit && rng.chance(rates.background)) {
      const back = Math.min(until - 3000, at + CLIENT.background.after + CLIENT.background.length);
      away = { from: at + CLIENT.background.after, to: back };
      this.offer(session, away.from, 'background', { chat });
      this.offer(session, away.to, 'foreground', { chat });
    }
    let blip = null;
    const blipFrom = away ? away.to + 1200 : at + CLIENT.blip.after;
    if (until - blipFrom > CLIENT.blip.minimumRemaining && rng.chance(rates.blip)) {
      blip = { from: blipFrom, to: blipFrom + CLIENT.blip.length };
      this.offer(session, blip.from, 'disconnect', { chat });
      this.offer(session, blip.to, 'reconnect', { chat });
    }
    for (let refresh = at + rng.between(...CLIENT.featureRenewal); refresh < until;
      refresh += rng.between(...CLIENT.featureRenewal)) {
      if (!blip || refresh < blip.from || refresh > blip.to) this.offer(session, refresh, 'chatRefresh', { chat });
    }

    const usable = Math.min(away?.from ?? until, blip?.from ?? until, until);
    this.visits[chat].push({ session, start: at + CLIENT.firstSendAfter, end: usable - 900 });
    if (rng.chance(persona.sendChance)) this.planBurst(session, persona, chat, at + CLIENT.firstSendAfter, usable);

    const preferencesAt = at + CLIENT.preferencesAfter;
    if (rng.chance(rates.pinMessage * (persona.admin ? 2 : 1))) this.offer(session, preferencesAt, 'pinMessage', { chat, reference: { back: 5 } });
    if (rng.chance(rates.mute)) this.offer(session, preferencesAt, 'mute', { chat });
    if (rng.chance(rates.pinChat)) this.offer(session, preferencesAt, 'pinChat', { chat });
    if (rng.chance(rates.unread)) this.offer(session, preferencesAt, 'unread', { chat });
    const source = chats.find(id => id !== chat);
    if (source !== undefined && rng.chance(rates.forward) && at + CLIENT.forwardAfter < usable) {
      this.offer(session, at + CLIENT.forwardAfter, 'forward', { chat, source, reference: { back: 6 }, bytes: 32, textSeed: session.id });
    }
    // A final read before leaving catches messages that arrived during the visit.
    if (until - at > 9000 && (!blip || until - 500 > blip.to)) this.offer(session, until - 500, 'read', { chat });
  }

  planBurst(session, persona, chat, from, usable) {
    const { rng, profile: { rates } } = this;
    let at = from;
    for (let n = 0; n <= persona.burst && at + 900 < usable; n++) {
      // Some replies quote recent history; the rest are planned later as answers to other people.
      const reference = rng.chance(rates.reply * .55) ? { back: 3 } : undefined;
      const id = this.send(session, at, chat, reference ? { reference } : {});
      if (rng.chance(rates.mutation) && at + CLIENT.mutationAfterSend < usable) {
        const type = rng.pick(['edit', 'edit', 'deleteSelf', 'deleteEveryone']);
        this.offer(session, at + CLIENT.mutationAfterSend, type, { chat, reference: { send: id }, bytes: 43, textSeed: id });
        if (type !== 'edit') this.deleted.add(id);
      }
      if (rng.chance(rates.readers) && at + CLIENT.readersAfterSend < usable && !this.deleted.has(id)) {
        this.offer(session, at + CLIENT.readersAfterSend, 'readers', { chat, reference: { send: id } });
      }
      at += rng.between(...CLIENT.sendGap);
    }
  }

  // Tops up replies to the profile's share by having someone else who is in the chat at the time answer.
  planReplies() {
    const { rng, profile: { rates, timing } } = this;
    const sends = this.actions.filter(action => action.type === 'send');
    const quoted = sends.filter(action => action.reference).length;
    const wanted = Math.max(0, Math.round((sends.length * rates.reply - quoted) / (1 - rates.reply)));
    let planned = 0;
    for (const parent of rng.shuffle(sends.filter(action => !action.reference && !this.deleted.has(action.id)))) {
      if (planned >= wanted) break;
      const earliest = parent.at + timing.replyMinMs;
      const latest = parent.at + timing.replyMaxMs;
      const present = this.visits[parent.chat].filter(visit =>
        visit.session.actor !== parent.actor && visit.start < latest && visit.end > Math.max(visit.start, earliest));
      if (present.length === 0) continue;
      const visit = rng.pick(present);
      this.send(visit.session, rng.between(Math.max(visit.start, earliest), Math.min(visit.end, latest)), parent.chat,
        { reference: { send: parent.id } });
      planned++;
    }
  }
}

export function buildPlan(profile, seed) {
  validateProfile(profile, seed);
  const rng = random(seed);
  const population = planPopulation(rng, profile);
  const { chats, directPairs, everyone } = planChats(rng, population, profile);
  const planner = new Planner(rng, profile, population, chats);
  const personas = Object.fromEntries(profile.personas.map(persona => [persona.name, persona]));
  for (const user of population) planner.planUser(user, personas[user.persona], directPairs, everyone);
  planner.planReplies();

  const actions = planner.actions.sort((a, b) => a.at - b.at || a.id - b.id);
  const sends = actions.filter(action => ['send', 'forward', 'direct'].includes(action.type));
  const perSecond = LIMITS.sendsPerSecond;
  if (sends.length > LIMITS.sends || sends.some((action, i) => i >= perSecond && action.at - sends[i - perSecond].at < 1000)) {
    throw new Error('Plan exceeds the send limits');
  }
  return { format: FORMAT, seed, profile, population, chats, sessions: planner.sessions, actions };
}
