export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function plan(users, scenario, seed) {
  if (!Number.isInteger(users) || users < 4 || users > 1000) throw new Error('users must be 4..1000');
  if (!['mixed', 'direct', 'small', 'large'].includes(scenario)) throw new Error('scenario must be mixed, direct, small or large');
  const rng = random(seed);
  const order = Array.from({ length: users }, (_, i) => i);
  for (let i = users - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chats = [];
  if (scenario === 'mixed' || scenario === 'direct') {
    for (let i = 0; i + 1 < users; i += 2) chats.push({ kind: 'DIRECT', cohort: 'direct', members: order.slice(i, i + 2) });
  }
  if (scenario === 'mixed' || scenario === 'small') {
    for (let i = 0; i < users; i += 8) {
      const members = order.slice(i, Math.min(users, i + 8));
      if (members.length > 1) chats.push({ kind: 'GROUP', cohort: 'small', members });
      else chats.at(-1)?.members.push(...members);
    }
  }
  if (scenario === 'mixed' || scenario === 'large') chats.push({ kind: 'GROUP', cohort: 'large', members: order });
  return chats;
}

export function offeredAt(elapsedMs, rate) { return Math.floor(elapsedMs * rate / 1000); }

export async function bounded(items, concurrency, action) {
  let next = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { await action(items[index], index); } catch (error) { failure ??= error; }
    }
  });
  await Promise.allSettled(workers);
  if (failure) throw failure;
}
