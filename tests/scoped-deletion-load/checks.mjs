import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ulid } from '../support/fixtures.mjs';
import { fixtureId } from './fixtures.mjs';
import { snapshot } from './runtime.mjs';

export async function functional(runtime) {
  const group = await runtime.group('rights-and-visibility');
  const a = await runtime.send(0, { chatId: group.id });
  const b = await runtime.send(1, { chatId: group.id });
  const reply = await runtime.send(1, { chatId: group.id, replyToMessageId: a.id });
  for (const message of [a, b, reply]) await runtime.notifications(message, group.members);
  const start = runtime.events.length;
  const deletionId = ulid();
  const hidden = await runtime.hints(() => runtime.deletion(0, group, 'SELF', 'MESSAGES', [a.id, b.id], deletionId), group, [0, 3]);
  assert.equal(hidden.operationId, deletionId);
  assert.equal(hidden.state, 'COMPLETED');
  for (const device of [0, 3]) {
    const result = await runtime.resolve(device, group, [a.id, b.id, reply.id]);
    assert.deepEqual(result.messages.map(message => message.id), [reply.id]);
    assert.equal(result.messages[0].replyBody, null, 'Hidden quote leaked');
  }
  assert.equal((await runtime.resolve(1, group, [a.id, b.id])).messages.length, 2);
  await delay(150);
  assert.ok(!runtime.events.slice(start).some(event => [1, 2].includes(event.device) && event.type === 'history_changed' && BigInt(event.visibilityRevision ?? '0') > 0n), 'Personal hint leaked to another account');
  const retried = await runtime.deletion(0, group, 'SELF', 'MESSAGES', [b.id, a.id], deletionId);
  assert.deepEqual(retried, hidden, 'Deletion retry changed its result');
  await runtime.deletion(0, group, 'EVERYONE', 'MESSAGES', [a.id, b.id], deletionId, [409]);
  await runtime.deletion(1, group, 'EVERYONE', 'MESSAGES', [a.id, b.id], ulid(), [403]);
  assert.equal((await runtime.resolve(1, group, [a.id, b.id])).messages.length, 2, 'Unauthorized batch partially applied');
  await runtime.deletion(1, group, 'EVERYONE', 'HISTORY', undefined, ulid(), [403]);
  await runtime.deletion(1, group, 'EVERYONE', 'CHAT', undefined, ulid(), [403]);
  await runtime.hints(() => runtime.deletion(1, group, 'EVERYONE', 'MESSAGES', [b.id]), group, group.members, 'EVERYONE');
  assert.equal((await runtime.resolve(2, group, [b.id])).messages.length, 0);
  await runtime.hints(() => runtime.deletion(0, group, 'EVERYONE', 'MESSAGES', [reply.id]), group, group.members, 'EVERYONE');
  assert.equal((await runtime.resolve(1, group, [reply.id])).messages.length, 0);
  await runtime.hints(() => runtime.deletion(0, group, 'SELF', 'HISTORY'), group, [0, 3]);
  const empty = snapshot(await runtime.api(0, `/chats/${group.id}/messages?limit=50`), true);
  assert.equal(empty.messages.length, 0);
  assert.ok((await runtime.api(0, '/chats?limit=100')).chats.some(chat => chat.id === group.id), 'Personal clear removed sidebar chat');
  await runtime.hints(() => runtime.deletion(0, group, 'SELF', 'CHAT'), group, [0, 3]);
  for (const device of [0, 3]) {
    assert.equal((await runtime.api(device, `/chats/${group.id}/visibility`)).hidden, true);
    assert.ok(!(await runtime.api(device, '/chats?limit=100')).chats.some(chat => chat.id === group.id));
  }
  assert.ok((await runtime.api(1, '/chats?limit=100')).chats.some(chat => chat.id === group.id));
  const resurfaced = await runtime.send(1, { chatId: group.id });
  await runtime.notifications(resurfaced, group.members);
  for (const device of [0, 3]) {
    assert.equal((await runtime.api(device, `/chats/${group.id}/visibility`)).hidden, false);
    assert.ok((await runtime.api(device, '/chats?limit=100')).chats.some(chat => chat.id === group.id));
    assert.deepEqual((await runtime.api(device, `/chats/${group.id}/messages?limit=50`)).messages.map(message => message.id), [resurfaced.id]);
  }
  const groupDeleted = await runtime.deletion(0, group, 'EVERYONE', 'CHAT');
  await runtime.complete(0, group, groupDeleted);
  for (const device of group.members) await runtime.api(device, `/chats/${group.id}/messages?limit=1`, { expect: [404] });

  const lookup = await runtime.api(0, `/chats/direct/${runtime.sockets[1].session.userId}`);
  assert.equal(lookup.chat, null, 'Fresh benchmark direct pair already exists');
  const directMessage = await runtime.send(0, { recipientId: runtime.sockets[1].session.userId });
  const direct = { id: directMessage.chatId, kind: 'DIRECT', members: [0, 1, 3], owned: true };
  await runtime.notifications(directMessage, direct.members);
  await runtime.hints(() => runtime.deletion(1, direct, 'EVERYONE', 'MESSAGES', [directMessage.id]), direct, direct.members, 'EVERYONE');
  assert.equal((await runtime.resolve(0, direct, [directMessage.id])).messages.length, 0);
  const originalEvents = runtime.seen.get(directMessage.requestId).eventIds.size;
  const queued = runtime.sockets[0].wait(event => event.type === 'queued' && event.requestId === directMessage.requestId);
  assert.ok(runtime.sockets[0].send({ type: 'send', recipientId: runtime.sockets[1].session.userId, requestId: directMessage.requestId, body: directMessage.body }));
  await queued;
  await delay(250);
  assert.equal(runtime.seen.get(directMessage.requestId).eventIds.size, originalEvents, 'Retry published a new saved body for deleted history');
  assert.equal((await runtime.resolve(0, direct, [directMessage.id])).messages.length, 0, 'Send retry resurrected purged row');
  const status = await runtime.api(0, `/sends/${directMessage.requestId}`);
  assert.equal(status.status, 'SAVED');
  assert.equal(status.messageId, directMessage.id);
  const closed = await runtime.deletion(1, direct, 'EVERYONE', 'CHAT');
  await runtime.complete(1, direct, closed);
  for (const device of direct.members) await runtime.api(device, `/chats/${direct.id}/messages?limit=1`, { expect: [404] });
  const fresh = await runtime.send(0, { recipientId: runtime.sockets[1].session.userId });
  assert.notEqual(fresh.chatId, direct.id, 'Global direct deletion reused old chat identity');
  await runtime.notifications(fresh, direct.members);
  await runtime.deletion(0, { ...direct, id: fresh.chatId }, 'EVERYONE', 'CHAT');
  return { passed: true, distinctAuthenticatedDevices: 4, accounts: 3, groupChatId: group.id, directChatId: direct.id, checks: ['self batch across two account sessions', 'other-account visibility', 'hidden quote', 'scoped hints', 'deletion retry/conflict', 'atomic group rights', 'own removal and creator moderation', 'self clear keeps sidebar', 'self hide and later send resurfaces', 'group/global and direct/global removal', 'bodyless send dedup after purge', 'fresh direct identity'] };
}

async function sample(runtime, actor, path, operation, repeats) {
  let result;
  for (let index = 0; index < repeats; index++) result = snapshot(await runtime.api(actor, path, { operation }), true);
  return result;
}

export async function messageBatches(runtime, fixtures, checkpoint) {
  const size = 10000;
  const chat = await runtime.group('message-batches-100');
  await checkpoint({ chat, size, purpose: 'maximum-size-message-batches' });
  const provision = await fixtures.seed(chat, runtime.sockets[1].session.userId, size);
  const selfIds = Array.from({ length: 100 }, (_, index) => fixtureId(chat.id, index + 1));
  const globalIds = Array.from({ length: 100 }, (_, index) => fixtureId(chat.id, index + 201));
  const before = await fixtures.storage(chat);
  assert.equal(before.messageRows, String(size));
  assert.equal(before.hiddenRanges, '0');
  let selfAcceptedMs;
  const self = await runtime.hints(async () => {
    const start = performance.now();
    const response = await runtime.deletion(0, chat, 'SELF', 'MESSAGES', selfIds);
    selfAcceptedMs = performance.now() - start;
    return response;
  }, chat, [0, 3]);
  assert.equal(self.state, 'COMPLETED');
  assert.equal(self.deletedRows, '0');
  const afterSelf = await fixtures.storage(chat);
  assert.equal(afterSelf.messageRows, String(size), 'Self batch physically removed shared history');
  assert.equal(afterSelf.hiddenRanges, '1', 'Contiguous self batch was not merged into one range');
  const ranges = await fixtures.ranges(chat, runtime.sockets[0].session.userId);
  assert.deepEqual(ranges, [{ afterSequence: '0', throughSequence: '100' }]);
  for (const actor of [0, 3]) assert.equal((await runtime.resolve(actor, chat, selfIds)).messages.length, 0);
  assert.equal((await runtime.resolve(1, chat, selfIds)).messages.length, 100);
  assert.equal((await runtime.resolve(0, chat, globalIds)).messages.length, 100);
  let everyoneAcceptedMs;
  const everyone = await runtime.hints(async () => {
    const start = performance.now();
    const response = await runtime.deletion(0, chat, 'EVERYONE', 'MESSAGES', globalIds);
    everyoneAcceptedMs = performance.now() - start;
    return response;
  }, chat, chat.members, 'EVERYONE');
  assert.equal(everyone.state, 'COMPLETED');
  assert.equal(everyone.deletedRows, '100');
  const afterEveryone = await fixtures.storage(chat);
  assert.equal(afterEveryone.messageRows, String(size - 100));
  assert.equal(afterEveryone.remainingOriginalBodies, String(size - 100));
  assert.equal(afterEveryone.outboxBodies, '0');
  for (const actor of chat.members) assert.equal((await runtime.resolve(actor, chat, globalIds)).messages.length, 0);
  assert.equal((await runtime.resolve(1, chat, selfIds)).messages.length, 100);
  const retainedIds = [101, 200, 301].map(sequence => fixtureId(chat.id, sequence));
  assert.deepEqual(new Set((await runtime.resolve(0, chat, retainedIds)).messages.map(row => row.id)), new Set(retainedIds), 'Global batch removed an unselected neighbor');
  return { chatId: chat.id, fixtureRows: size, provision, batchSize: 100, historyAuthor: 'Other group member, with creator-authorized global removal', writeThroughputBenchmark: false, self: { acceptedMs: selfAcceptedMs, state: self.state, physicallyDeletedRows: self.deletedRows, ranges, storage: afterSelf }, everyone: { acceptedMs: everyoneAcceptedMs, state: everyone.state, physicallyDeletedRows: everyone.deletedRows, storage: afterEveryone }, beforeStorage: before };
}

export async function history(runtime, fixtures, size, checkpoint) {
  const chat = await runtime.group(`history-${size}`);
  await checkpoint({ chat, size });
  const provision = await fixtures.seed(chat, runtime.sockets[0].session.userId, size);
  const result = { size, chatId: chat.id, provision, cacheState: 'First request after fixture insert, then repeated warm requests. No OS/DB cache flush.', spanBudget: 16 };
  const label = `history.${size}`;
  const initial = await sample(runtime, 0, `/chats/${chat.id}/messages?limit=50`, `${label}.latest.initial`, 1);
  assert.deepEqual(initial.messages.map(row => Number(row.sequence)), Array.from({ length: 50 }, (_, index) => size - 49 + index));
  await fixtures.hide(chat, runtime.sockets[0].session.userId, size, 'middle');
  const low = Math.floor(size * .05);
  const high = Math.floor(size * .95);
  const latest = await sample(runtime, 0, `/chats/${chat.id}/messages?limit=50`, `${label}.latest`, runtime.options.repeats);
  assert.equal(latest.messages.length, 50);
  const older = await sample(runtime, 0, `/chats/${chat.id}/messages?beforeSeq=${high + 1}&limit=50`, `${label}.older.middle`, runtime.options.repeats);
  assert.equal(older.messages.at(-1)?.sequence, String(low));
  const after = await sample(runtime, 0, `/chats/${chat.id}/messages?afterSeq=${low}&limit=50`, `${label}.after.middle`, runtime.options.repeats);
  assert.equal(after.messages[0]?.sequence, String(high + 1));
  const around = await sample(runtime, 0, `/chats/${chat.id}/messages/around?anchorSequence=${Math.floor(size / 2)}&limit=50`, `${label}.around.hidden`, runtime.options.repeats);
  assert.ok(around.anchorMessageId && around.messages.every(row => Number(row.sequence) <= low || Number(row.sequence) > high));
  const gone = fixtureId(chat.id, Math.floor(size / 2));
  for (let index = 0; index < runtime.options.repeats; index++) assert.equal((await runtime.resolve(0, chat, [gone, fixtureId(chat.id, size)])).messages.length, 1);
  assert.equal((await runtime.resolve(1, chat, [gone])).messages.length, 1, 'SQL visibility fixture affected another member');
  result.middle = { range: [low + 1, high], olderLast: older.messages.at(-1)?.sequence, afterFirst: after.messages[0]?.sequence, nearestAnchorId: around.anchorMessageId };
  result.plans = await fixtures.plans(chat, runtime.sockets[0].session.userId, size);
  await fixtures.hide(chat, runtime.sockets[0].session.userId, size, 'alternating');
  let cursor = '0';
  const received = [];
  let pages = 0;
  let shortPages = 0;
  while (BigInt(cursor) < 200n) {
    const page = snapshot(await runtime.api(0, `/chats/${chat.id}/messages?afterSeq=${cursor}&limit=100`, { operation: `${label}.alternating` }), true);
    assert.ok(BigInt(page.nextSequence) > BigInt(cursor), 'Sparse continuation did not progress');
    assert.equal(page.coverageAfterSequence, cursor);
    assert.equal(page.coverageThroughSequence, page.nextSequence);
    for (const row of page.messages) if (Number(row.sequence) <= 200) received.push(Number(row.sequence));
    if (page.messages.length < 100 && page.hasMore) shortPages++;
    cursor = page.nextSequence;
    assert.ok(++pages <= 32, 'Alternating intervals exceeded bounded page count');
  }
  assert.deepEqual(received, Array.from({ length: 100 }, (_, index) => index * 2 + 1));
  assert.ok(shortPages > 0, 'Fixture did not exercise the span budget');
  result.alternating = { intervals: 100, pages, shortPages, nextSequence: cursor };
  const beforeStorage = await fixtures.storage(chat);
  const submit = performance.now();
  const accepted = await runtime.deletion(0, chat, 'EVERYONE', 'HISTORY');
  const acceptedMs = performance.now() - submit;
  assert.equal(accepted.clearedThroughSequence, String(size));
  const later = await runtime.send(1, { chatId: chat.id });
  await runtime.notifications(later, chat.members);
  const completion = await runtime.complete(0, chat, accepted);
  const elapsedMs = performance.now() - submit;
  const retirementWaitMs = await fixtures.waitForPurgeRetirement(chat);
  const afterStorage = await fixtures.storage(chat);
  assert.equal(afterStorage.remainingOriginalBodies, '0');
  assert.equal(afterStorage.messageRows, '1', 'Purge deleted later accepted send or retained old rows');
  assert.equal(afterStorage.purgeJobs, '0');
  assert.equal(afterStorage.outboxBodies, '0');
  assert.equal(completion.deletedRows, String(size));
  for (const device of [0, 1, 3]) assert.deepEqual((await runtime.api(device, `/chats/${chat.id}/messages?limit=50`)).messages.map(row => row.id), [later.id]);
  result.purge = { acceptedMs, initially: accepted.state, completionMs: elapsedMs, retirementWaitMs, deletedRows: completion.deletedRows, observedRowsPerSecond: size / (elapsedMs / 1000), pollIntervalMs: 100, beforeStorage, afterStorage };
  return result;
}

export async function mixed(runtime, fixtures, sizes, checkpoint) {
  const live = await runtime.group('mixed-live');
  const results = [];
  let stopping = false;
  let sends = 0;
  let reconnects = 0;
  let liveError;
  const ready = Promise.withResolvers();
  const worker = (async () => {
    try {
      while (!stopping) {
        if (sends === 2) {
          await runtime.sockets[2].disconnect();
          const offline = await runtime.send(0, { chatId: live.id });
          await runtime.notifications(offline, [0, 1, 3]);
          await runtime.sockets[2].connect();
          await runtime.sockets[2].subscribe({ ...live, baseline: '0' });
          const recovered = snapshot(await runtime.api(2, `/chats/${live.id}/messages?afterSeq=0&limit=100`, { operation: 'mixed.reconnectRecovery' }), true);
          assert.ok(recovered.messages.some(row => row.id === offline.id), 'Reconnect lost offline accepted send');
          reconnects++;
          ready.resolve();
        }
        const saved = await runtime.send(sends % 2, { chatId: live.id });
        await runtime.notifications(saved, live.members);
        sends++;
        await delay(500);
      }
    } catch (error) { liveError = error; ready.reject(error); }
  })();
  try {
    await ready.promise;
    for (const size of sizes) results.push(await history(runtime, fixtures, size, checkpoint));
  } finally {
    stopping = true;
    await worker;
  }
  if (liveError) throw liveError;
  assert.ok(sends >= 3 && reconnects === 1, 'Mixed fixture did not exercise live traffic and reconnect');
  return { histories: results, live: { chatId: live.id, sends, reconnects, offeredModel: 'One sequential send every 500 ms plus one offline send. Backpressure reduces offered rate.', missingNotifications: 0 } };
}
