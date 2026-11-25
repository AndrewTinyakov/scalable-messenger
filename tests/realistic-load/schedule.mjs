import { setTimeout as delay } from 'node:timers/promises';
import { Fault } from './transport.mjs';

export async function schedule(actions, dispatch, {
  now = () => performance.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  signal,
  lag,
  failed,
  limit = 512,
} = {}) {
  const active = new Set();
  const started = now();
  let offered = 0;
  let peak = 0;
  try {
    for (const action of actions) {
      signal?.throwIfAborted();
      const due = started + action.at;
      for (let remaining = due - now(); remaining > 0; remaining = due - now()) await sleep(remaining, signal);
      lag?.(Math.max(0, now() - due), action);
      offered++;
      if (active.size >= limit) {
        failed?.(action, new Fault('scheduleCapacity'));
        continue;
      }
      const work = Promise.resolve().then(() => dispatch(action, due))
        .catch(error => failed?.(action, error))
        .finally(() => active.delete(work));
      active.add(work);
      peak = Math.max(peak, active.size);
    }
  } finally {
    await Promise.all(active);
  }
  return { offered, peak, pending: active.size };
}

export async function resolveReference(reference, lookup, recent) {
  if (reference?.send !== undefined) return (await lookup(reference.send)) ?? null;
  if (reference?.back !== undefined) return recent.at(-reference.back) ?? null;
  return null;
}
