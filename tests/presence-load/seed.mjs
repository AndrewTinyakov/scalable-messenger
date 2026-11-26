// Loads the plan into a fresh stack's PostgreSQL and fetches WebSocket tickets.
// Creating 400,000 direct chats over HTTP would take hours; the rows written here
// are the ones both builds' authorization queries read: users, sessions, chats
// and memberships.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { workers } from '../realistic-load/setup.mjs';
import { Http, Measurements } from '../realistic-load/transport.mjs';

const COOKIE_NAMES = ['__Host-messenger_session', 'messenger_session'];

const csv = values => values.map(value => value === null ? '' : `"${String(value).replaceAll('"', '""')}"`).join(',') + '\n';

function* rows(plan, tokens) {
  yield 'BEGIN;\n';
  yield 'COPY users (id, username, password_hash) FROM STDIN WITH (FORMAT csv);\n';
  // An unusable hash: these accounts only sign in through seeded sessions.
  for (const user of plan.users) yield csv([user.id, user.username, '!presence-load']);
  yield '\\.\n';
  yield 'COPY sessions (token_hash, user_id, device_id, expires_at, device_label) FROM STDIN WITH (FORMAT csv);\n';
  const expires = new Date(Date.now() + 2 * 86400_000).toISOString();
  for (const [index, user] of plan.users.entries()) {
    yield csv([createHash('sha256').update(tokens[index]).digest('hex'), user.id, deviceId(index), expires, 'Presence load']);
  }
  yield '\\.\n';
  yield 'COPY chats (id, kind, name, direct_pair_key, member_count, owner_id) FROM STDIN WITH (FORMAT csv);\n';
  for (const chat of plan.directs) {
    yield csv([chat.id, 'DIRECT', null, `${plan.users[chat.low].id}:${plan.users[chat.high].id}`, 2, null]);
  }
  for (const group of plan.groups) yield csv([group.id, 'GROUP', group.name, null, group.members.length, plan.users[group.owner].id]);
  yield '\\.\n';
  yield 'COPY chat_members (chat_id, user_id) FROM STDIN WITH (FORMAT csv);\n';
  for (const chat of plan.directs) {
    yield csv([chat.id, plan.users[chat.low].id]);
    yield csv([chat.id, plan.users[chat.high].id]);
  }
  for (const group of plan.groups) {
    for (const member of group.members) yield csv([group.id, plan.users[member].id]);
  }
  yield '\\.\n';
  yield 'COMMIT;\nANALYZE users; ANALYZE sessions; ANALYZE chats; ANALYZE chat_members;\n';
}

export const deviceId = index => 'presence-load-' + index;

export async function seedDatabase(plan, project) {
  const tokens = plan.users.map(() => randomBytes(32).toString('base64url'));
  const psql = spawn('docker', ['exec', '-i', `${project}-postgres-1`, 'psql', '-U', 'postgres', '-d', 'messenger', '-q', '-v', 'ON_ERROR_STOP=1'],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const exited = once(psql, 'exit');
  let batch = '';
  for (const row of rows(plan, tokens)) {
    batch += row;
    if (batch.length < 1 << 16) continue;
    if (!psql.stdin.write(batch)) await once(psql.stdin, 'drain');
    batch = '';
  }
  psql.stdin.end(batch);
  const [code] = await exited;
  if (code !== 0) throw new Error(`psql exited with ${code}`);
  return tokens;
}

export function session(manifest, plan, index) {
  return { cookie: `${manifest.cookieName}=${manifest.tokens[index]}`, userId: plan.users[index].id, deviceId: deviceId(index) };
}

// The API reads one cookie name, chosen by its secure-cookie setting.
export async function detectCookieName(http, manifest, plan) {
  for (const cookieName of COOKIE_NAMES) {
    try {
      await http.request(session({ ...manifest, cookieName }, plan, 0), '/auth/ws-ticket', 'POST');
      return cookieName;
    } catch (error) {
      if (error.code !== 'http401') throw error;
    }
  }
  throw new Error('No session cookie name was accepted; was the database seeded?');
}

export function ticketClient({ api, origin, ticketRate }) {
  return new Http({ api, origin, authRate: 1, ticketRate, capacity: 4 }, new Measurements());
}

// Tickets last an hour and the gateway does not consume them, so a client
// reuses one for every reconnect. `expiresAt` is in Unix seconds.
export async function fetchTickets(http, manifest, plan, users, tickets = new Map()) {
  await workers(users, 128, async index => {
    const ticket = await http.request(session(manifest, plan, index), '/auth/ws-ticket', 'POST');
    tickets.set(index, { token: ticket.token, expiresAt: ticket.expiresAt * 1000 });
  });
  return tickets;
}

// Replaces tickets that expire within ten minutes, once a minute, until stopped.
export function refreshTickets(http, manifest, plan, tickets, log) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const due = [...tickets].filter(([, ticket]) => ticket.expiresAt - Date.now() < 10 * 60_000).map(([index]) => index);
    if (!due.length) return;
    running = true;
    log(`refreshing ${due.length} tickets`);
    try {
      await fetchTickets(http, manifest, plan, due, tickets);
    } catch (error) {
      log(`ticket refresh failed: ${error.message}`);
    } finally {
      running = false;
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function writeManifest(path, manifest) {
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
