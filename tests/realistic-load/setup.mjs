import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ulid } from '../support/fixtures.mjs';
import { writePrivate } from '../features-load/http.mjs';
import { check, Fault, isId, Socket } from './transport.mjs';

export function messageText(bytes, textSeed) {
  const words = ['yeah', 'later', 'thanks', 'okay', 'right', 'today', 'sounds good', 'one sec', 'got it', 'sure'];
  let state = textSeed >>> 0;
  let result = '';
  while (result.length < bytes) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    result += words[state % words.length] + ' ';
  }
  return result.slice(0, bytes).trimEnd().padEnd(bytes, '.');
}

export async function workers(items, count, work) {
  let cursor = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (failure === undefined && cursor < items.length) {
      const item = items[cursor++];
      try {
        await work(item);
      } catch (error) {
        failure ??= error;
      }
    }
  }));
  if (failure) throw failure;
}

export async function authenticate(http, device, mode) {
  const { username, password, deviceId } = device;
  const response = await http.request(device, '/auth/' + mode, 'POST', { username, password, deviceId });
  check(isId(response?.user?.id) && response.deviceId === deviceId && response.user.username === username);
  check(!device.userId || device.userId === response.user.id, 'wrongSession');
  device.userId = response.user.id;
}

function docker(args, signal, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { signal, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 65536) child.kill();
    });
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Fault('fixtureDocker')));
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Fault('fixtureSqlOrDocker')));
    child.stdin.end(input);
  });
}

// Older history is bulk-copied straight into Postgres. It bypasses the broker, so it produces no live events.
async function loadFixture(project, plan, manifest, firstMessages, signal) {
  const db = await docker(['compose', '-p', project, 'ps', '-q', 'postgres'], signal);
  check(/^[a-f0-9]{12,64}$/.test(db), 'fixtureContainer');
  const rows = [];
  for (const chat of plan.chats) {
    const id = manifest.chats[chat.id];
    check(isId(id));
    const ids = chat.history.map((_, index) => index === 0 && chat.kind === 'DIRECT' ? firstMessages.get(chat.id) : ulid());
    for (const [index, fixture] of chat.history.entries()) {
      if (index === 0 && chat.kind === 'DIRECT') continue;
      const actor = manifest.devices[fixture.actor][0].userId;
      check(isId(actor));
      const quote = fixture.replyTo === undefined ? '\\N' : ids[fixture.replyTo];
      check(quote === '\\N' || (isId(quote) && fixture.replyTo < index));
      rows.push([ids[index], id, index + 1, actor, messageText(fixture.bytes, fixture.textSeed), quote].join('\t'));
    }
  }
  const topology = plan.chats.map(chat => [manifest.chats[chat.id], chat.kind, chat.history.length].join('\t'));
  const sql = [
    "SET statement_timeout='60s'; BEGIN;",
    'CREATE TEMP TABLE fixture_chats (id text PRIMARY KEY, kind text, size bigint);',
    'COPY fixture_chats FROM STDIN;',
    ...topology, '\\.',
    `DO $$ BEGIN
      IF EXISTS (SELECT FROM fixture_chats f LEFT JOIN chats c ON c.id=f.id WHERE
        c.id IS NULL OR c.kind::text<>f.kind OR c.deleted_at IS NOT NULL OR
        c.next_sequence<>CASE WHEN f.kind='DIRECT' THEN 2 ELSE 1 END)
      THEN RAISE EXCEPTION 'Fixture chat at unexpected sequence'; END IF;
    END $$;`,
    'CREATE TEMP TABLE fixture_messages (id text, chat_id text, sequence bigint, sender_id text, body text, reply_to_message_id text);',
    'COPY fixture_messages FROM STDIN;',
    ...rows, '\\.',
    `INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at,reply_to_message_id)
      SELECT id,chat_id,sequence,sender_id,body,now()+sequence*interval '1 microsecond',reply_to_message_id
      FROM fixture_messages;`,
    'UPDATE chats c SET next_sequence=f.size+1,last_message_sequence=f.size,last_activity_at=now() FROM fixture_chats f WHERE c.id=f.id;',
    'COMMIT;',
  ].join('\n');
  await docker(['exec', '-i', db, 'sh', '-c', 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    AbortSignal.any([signal, AbortSignal.timeout(70000)]), sql + '\n');
}

async function seedDirect(socket, send, frame) {
  const requestId = ulid();
  let timer;
  try {
    const terminal = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Fault('fixtureSendTimeout')), 15000);
      send.receive = event => {
        if (event.requestId !== requestId) return;
        if (event.type === 'message_saved') resolve(event);
        if (event.type === 'send_rejected' || event.type === 'error') reject(new Fault('fixtureSendRejected'));
      };
    });
    socket.send({ type: 'send', requestId, ...frame });
    return await terminal;
  } finally {
    clearTimeout(timer);
    send.receive = () => {};
  }
}

export async function setup(plan, options, http, fingerprint) {
  const tag = 'rl' + randomBytes(5).toString('hex');
  const devices = plan.population.map(user => {
    const username = tag + 'u' + user.id;
    const password = randomBytes(18).toString('hex');
    return Array.from({ length: user.devices }, (_, index) => ({ username, password, deviceId: tag + 'd' + user.id + '-' + index }));
  });
  const manifest = { format: 'realistic-load-session-v1', fingerprint, tag, devices, chats: [] };
  // The first device registers the account; the user's other devices sign in to it.
  await workers(devices, 12, async ([first, ...others]) => {
    await authenticate(http, first, 'register');
    for (const device of others) {
      device.userId = first.userId;
      await authenticate(http, device, 'login');
    }
  });
  process.stdout.write(`Provisioned ${devices.length} users and ${devices.flat().length} device credentials\n`);
  const firstMessages = new Map();
  const outgoing = devices.map(() => []);
  for (const chat of plan.chats) if (chat.kind === 'DIRECT') outgoing[chat.members[0]].push(chat);
  await workers(outgoing.filter(row => row.length), 16, async row => {
    const owner = devices[row[0].members[0]][0];
    const callback = { receive: () => {} };
    const socket = new Socket(http, owner, event => {
      if (event.type === 'message_saved') socket.send({ type: 'received_message', chatId: event.chatId, sequence: event.sequence });
      callback.receive(event);
    });
    try {
      await socket.open();
      for (const chat of row) {
        const { bytes, textSeed } = chat.history[0];
        const saved = await seedDirect(socket, callback, {
          recipientId: devices[chat.members[1]][0].userId,
          body: messageText(bytes, textSeed),
        });
        manifest.chats[chat.id] = saved.chatId;
        firstMessages.set(chat.id, saved.messageId);
      }
    } finally {
      await socket.close();
    }
  });
  await workers(plan.chats.filter(chat => chat.kind === 'GROUP'), 12, async chat => {
    const created = await http.request(devices[chat.members[0]][0], '/chats/groups', 'POST', {
      name: 'Realistic ' + tag + ' ' + chat.id,
      memberIds: chat.members.slice(1).map(actor => devices[actor][0].userId),
    });
    check(isId(created?.id));
    manifest.chats[chat.id] = created.id;
  });
  await loadFixture(options.composeProject, plan, manifest, firstMessages, http.controller.signal);
  await writePrivate(options.manifest, manifest);
  process.stdout.write(`Seeded ${plan.chats.length} chats with ${plan.chats.reduce((total, chat) => total + chat.history.length, 0)} messages\n`);
  return manifest;
}
