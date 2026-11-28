import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureId, Fixtures } from './fixtures.mjs';
import { snapshot } from './runtime.mjs';
import { messageBatches, mixed } from './checks.mjs';

test('fixture identities are valid, deterministic and scoped to their own chat', () => {
  const chat = '01JBT0P1111111111111111111';
  assert.match(fixtureId(chat, 1000000), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.equal(fixtureId(chat, 1), fixtureId(chat, 1));
  assert.notEqual(fixtureId(chat, 1), fixtureId(chat, 2));
  assert.notEqual(fixtureId(chat, 1), fixtureId('01JBT0P2222222222222222222', 1));
});

test('sparse coverage accepts certified absences and rejects rows outside its interval', () => {
  const page = { snapshotSequence: '1000000', visibilitySeq: '1', clearedThroughSequence: '0', globalClearedThroughSequence: '0', coverageAfterSequence: '100', coverageThroughSequence: '999900', messages: [{ sequence: '101' }, { sequence: '999900' }] };
  assert.equal(snapshot(page, true), page);
  assert.equal(snapshot({ ...page, messages: [] }, true).messages.length, 0);
  assert.throws(() => snapshot({ ...page, messages: [{ sequence: '100' }] }, true));
  assert.throws(() => snapshot({ ...page, messages: [{ sequence: '999901' }] }, true));
  assert.throws(() => snapshot({ ...page, snapshotSequence: 1000000 }, true));
});

test('100-ID batch checks require merged personal storage and physical global removal', async () => {
  const run = async fault => {
    const chat = { id: '01JBT0P1111111111111111111', members: [0, 1, 2, 3], owned: true };
    const hidden = new Set();
    const removed = new Set();
    const runtime = {
      sockets: [{ session: { userId: 'creator' } }, { session: { userId: 'author' } }],
      group: async () => chat,
      hints: async action => action(),
      deletion: async (_actor, _chat, scope, target, ids) => {
        assert.equal(target, 'MESSAGES');
        assert.equal(ids.length, 100);
        assert.equal(new Set(ids).size, 100);
        for (const id of ids) (scope === 'SELF' ? hidden : removed).add(id);
        return { state: 'COMPLETED', deletedRows: scope === 'SELF' ? '0' : '100' };
      },
      resolve: async (actor, _chat, ids) => ({ messages: ids.filter(id => !removed.has(id) && !([0, 3].includes(actor) && hidden.has(id))).map(id => ({ id })) }),
    };
    const fixtures = {
      seed: async (_chat, author, rows) => { assert.equal(author, 'author'); assert.equal(rows, 10000); return { rows }; },
      storage: async () => ({ messageRows: String(10000 - (fault === 'retainedRows' ? 0 : removed.size)), remainingOriginalBodies: String(10000 - removed.size), hiddenRanges: hidden.size ? fault === 'unmerged' ? '100' : '1' : '0', outboxBodies: '0' }),
      ranges: async () => [{ afterSequence: '0', throughSequence: '100' }],
    };
    return messageBatches(runtime, fixtures, async fixture => assert.equal(fixture.purpose, 'maximum-size-message-batches'));
  };
  const result = await run();
  assert.equal(result.batchSize, 100);
  assert.equal(result.everyone.storage.messageRows, '9900');
  assert.ok(result.self.acceptedMs >= 0 && result.everyone.acceptedMs >= 0);
  await assert.rejects(run('unmerged'), /not merged/);
  await assert.rejects(run('retainedRows'));
});

test('mixed traffic completes its reconnect before historical fixture creation', async () => {
  const actions = [];
  const chat = { id: 'live', members: [0, 1, 2, 3] };
  let sequence = 0;
  const runtime = {
    group: async name => {
      if (name !== 'mixed-live') actions.push('history-group');
      return chat;
    },
    sockets: [{ session: { userId: 'author' } }, null, {
      disconnect: async () => actions.push('disconnect'),
      connect: async () => actions.push('connect'),
      subscribe: async () => actions.push('subscribe'),
    }],
    send: async () => ({ id: String(++sequence) }),
    notifications: async () => {},
    api: async () => {
      actions.push('recover');
      return { snapshotSequence: '3', visibilitySeq: '0', clearedThroughSequence: '0', globalClearedThroughSequence: '0', coverageAfterSequence: '0', coverageThroughSequence: '3', messages: [{ id: '3', sequence: '3' }] };
    },
  };
  const stop = new Error('fixture checkpoint');
  await assert.rejects(mixed(runtime, { seed: async () => { throw stop; } }, [10000], async () => {}), stop);
  assert.deepEqual(actions, ['disconnect', 'connect', 'subscribe', 'recover', 'history-group']);
});

test('physical completion waits separately for bounded purge job retirement', async () => {
  const fixtures = new Fixtures({ tag: 'test', timeout: 1 });
  const chat = { id: '01JBT0P1111111111111111111', name: 'Scoped deletion test history', owned: true };
  const rows = ['1', '0'];
  fixtures.sql = async () => rows.shift();
  await fixtures.waitForPurgeRetirement(chat);
  assert.deepEqual(rows, []);
  fixtures.options.timeout = 0;
  fixtures.sql = async () => '1';
  await assert.rejects(fixtures.waitForPurgeRetirement(chat), /retirement timed out/);
});
