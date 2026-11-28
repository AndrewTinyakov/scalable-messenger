import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const id = value => { assert.match(value, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/); return `'${value}'`; };
export const fixtureId = (chatId, sequence) => `7${createHash('md5').update(`${chatId}:${sequence}`).digest('hex').slice(0, 25).toUpperCase()}`;

async function command(args, input = '') {
  return new Promise((resolve, reject) => {
    const process = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    process.stdout.on('data', value => { output += value; if (output.length > 4 * 2 ** 20) process.kill(); });
    process.stderr.on('data', value => { errors = (errors + value).slice(-4096); });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Docker fixture command failed (${code}): ${errors.slice(0, 500)}`)));
    process.stdin.on('error', () => {});
    process.stdin.end(input);
  });
}

export class Fixtures {
  constructor(options) { this.options = options; }
  async verify() {
    const containers = JSON.parse(await command(['inspect', this.options.postgres]));
    const labels = containers[0]?.Config?.Labels;
    assert.equal(labels?.['com.docker.compose.project'], this.options.project, 'Postgres project differs from explicit benchmark project');
    assert.equal(labels?.['com.docker.compose.service'], 'postgres', 'Fixture target is not the postgres service');
    this.verified = true;
  }
  async sql(sql) {
    assert.ok(this.verified, 'Verify fixture database before access');
    return command(['exec', '-i', this.options.postgres, 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'messenger', '-d', 'messenger'], `SET statement_timeout='60s';\n${sql}\n`);
  }
  guard(chat) {
    assert.ok(chat.owned && chat.name?.startsWith(`Scoped deletion ${this.options.tag} `), 'Foreign fixture refused');
    assert.match(chat.name, /^[a-zA-Z0-9 ._-]+$/);
    return `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM chats WHERE id=${id(chat.id)} AND name='${chat.name}' AND deleted_at IS NULL) THEN RAISE EXCEPTION 'Foreign benchmark chat'; END IF; END $$;`;
  }
  async seed(chat, sender, size) {
    assert.ok([10000, 100000, 1000000].includes(size));
    const start = performance.now();
    await this.sql(`BEGIN;
      ${this.guard(chat)}
      SELECT id FROM chats WHERE id=${id(chat.id)} FOR UPDATE;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM messages WHERE chat_id=${id(chat.id)}) THEN RAISE EXCEPTION 'Fixture is not empty'; END IF; END $$;
      INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at)
      SELECT '7'||upper(substr(md5(${id(chat.id)}||':'||n::text),1,25)),${id(chat.id)},n,${id(sender)},repeat('h',128),now()-interval '1 day'+n*interval '1 millisecond' FROM generate_series(1,${size}) n;
      UPDATE chats SET next_sequence=${size + 1} WHERE id=${id(chat.id)};
      COMMIT;
      ANALYZE messages;`);
    return { rows: size, bodyBytes: 128, provisionMs: performance.now() - start };
  }
  async hide(chat, actor, size, pattern) {
    assert.ok(['middle', 'alternating'].includes(pattern));
    const ranges = pattern === 'middle'
      ? `SELECT ${id(chat.id)},${id(actor)},${Math.floor(size * .05)},${Math.floor(size * .95)}`
      : `SELECT ${id(chat.id)},${id(actor)},n-1,n FROM generate_series(2,200,2) n`;
    await this.sql(`BEGIN; ${this.guard(chat)}
      DELETE FROM hidden_message_ranges WHERE chat_id=${id(chat.id)} AND user_id=${id(actor)};
      INSERT INTO hidden_message_ranges(chat_id,user_id,after_sequence,through_sequence) ${ranges};
      UPDATE chat_members SET member_seq=member_seq+1, visibility_seq=member_seq+1 WHERE chat_id=${id(chat.id)} AND user_id=${id(actor)};
      COMMIT; ANALYZE hidden_message_ranges;`);
  }
  async storage(chat) {
    return JSON.parse(await this.sql(`SELECT json_build_object(
      'messageRows',(SELECT count(*)::text FROM messages WHERE chat_id=${id(chat.id)}),
      'changeRows',(SELECT count(*)::text FROM message_changes WHERE chat_id=${id(chat.id)}),
      'hiddenRanges',(SELECT count(*)::text FROM hidden_message_ranges WHERE chat_id=${id(chat.id)}),
      'purgeJobs',(SELECT count(*)::text FROM history_purge_jobs WHERE chat_id=${id(chat.id)}),
      'outboxBodies',(SELECT count(*)::text FROM messenger_outbox_events WHERE payload->>'chatId'=${id(chat.id)} AND (payload ? 'body' OR payload ? 'replyBody')),
      'remainingOriginalBodies',(SELECT count(*)::text FROM messages WHERE chat_id=${id(chat.id)} AND body=repeat('h',128)));`));
  }
  async ranges(chat, actor) {
    return JSON.parse(await this.sql(`${this.guard(chat)}
      SELECT COALESCE(json_agg(json_build_object('afterSequence',after_sequence::text,'throughSequence',through_sequence::text) ORDER BY after_sequence),'[]'::json)
      FROM hidden_message_ranges WHERE chat_id=${id(chat.id)} AND user_id=${id(actor)};`));
  }
  async waitForPurgeRetirement(chat) {
    const start = performance.now();
    while (await this.sql(`${this.guard(chat)} SELECT count(*) FROM history_purge_jobs WHERE chat_id=${id(chat.id)};`) !== '0') {
      assert.ok(performance.now() - start < this.options.timeout * 1000, 'Purge job retirement timed out');
      await delay(100);
    }
    return performance.now() - start;
  }
  async plans(chat, actor, size) {
    const chatId = id(chat.id);
    const userId = id(actor);
    const middle = Math.floor(size / 2);
    const end = Math.floor(size * .95);
    const queries = {
      containing: `SELECT * FROM hidden_message_ranges WHERE chat_id=${chatId} AND user_id=${userId} AND after_sequence<${middle} ORDER BY after_sequence DESC LIMIT 1`,
      next: `SELECT * FROM hidden_message_ranges WHERE chat_id=${chatId} AND user_id=${userId} AND after_sequence>=${end} ORDER BY after_sequence LIMIT 1`,
      messageSpan: `SELECT * FROM messages m WHERE chat_id=${chatId} AND sequence>${end} AND sequence<=${size} AND EXISTS(SELECT 1 FROM chat_members cm JOIN chats c ON c.id=cm.chat_id WHERE cm.chat_id=${chatId} AND cm.user_id=${userId} AND c.deleted_at IS NULL AND m.sequence>cm.cleared_through_sequence AND m.sequence>c.cleared_through_sequence) AND m.sequence>COALESCE((SELECT r.through_sequence FROM hidden_message_ranges r WHERE r.chat_id=${chatId} AND r.user_id=${userId} AND r.after_sequence<m.sequence ORDER BY r.after_sequence DESC LIMIT 1),0) ORDER BY sequence LIMIT 51`,
    };
    const result = {};
    for (const [name, sql] of Object.entries(queries)) result[name] = JSON.parse(await this.sql(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql};`));
    return { source: 'Repository-equivalent indexed span and interval queries, not an HTTP request trace', queries, plans: result };
  }
  async resources() {
    const containers = (await command(['ps', '--filter', `label=com.docker.compose.project=${this.options.project}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean);
    const inspected = JSON.parse(await command(['inspect', ...containers]));
    const topology = inspected.map(container => ({ service: container.Config.Labels['com.docker.compose.service'], image: container.Image, memoryLimit: container.HostConfig.Memory, nanoCpus: container.HostConfig.NanoCpus }));
    const stats = await command(['stats', '--no-stream', '--format', '{{json .}}', ...containers]);
    return { topology, stats: stats.split('\n').map(row => JSON.parse(row)) };
  }
}
