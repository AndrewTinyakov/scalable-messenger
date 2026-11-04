import { ulid } from '../support/fixtures.mjs';
import { plan } from './plan.mjs';
import { readPrivate, writePrivate } from './http.mjs';

async function seed(socket, frame) {
  const requestId = ulid();
  const terminal = socket.wait(event => event.requestId === requestId && ['message_saved', 'send_rejected'].includes(event.type));
  if (!socket.send({ type: 'send', requestId, body: 'Feature benchmark anchor', ...frame })) throw new Error('Setup send failed');
  const saved = await terminal;
  if (saved.type !== 'message_saved') throw new Error(`Setup send rejected: ${saved.reason}`);
  return { id: saved.messageId, chatId: saved.chatId, sequence: saved.sequence, version: saved.messageVersion ?? '1', sender: socket.index };
}

export async function topology(options, http, sockets, source) {
  if (options.phase === 'measure') {
    if (source.format !== 'messenger-features-topology-v1') throw new Error('Measurement requires a feature topology');
    if (source.scenario !== options.scenario || source.seed !== options.seed || source.sessions.length !== options.users) throw new Error('Topology seed/scenario/users mismatch');
    if (!Array.isArray(source.chats) || source.chats.length > 1000 || source.chats.length < 1) throw new Error('Invalid bounded chat topology');
    for (const chat of source.chats) {
      if (!chat.owned || !chat.anchor || !chat.mutable || !['DIRECT', 'GROUP'].includes(chat.kind) || !Array.isArray(chat.members) || chat.members.length < 2 || chat.members.length > 1000 || chat.members.some(member => !Number.isInteger(member) || member < 0 || member >= options.users) || new Set(chat.members).size !== chat.members.length) throw new Error('Invalid owned topology');
      const current = await http.request(sockets[chat.members[0]].session, `/chats/${chat.id}`);
      chat.baseline = current.lastSequence;
    }
    return source.chats;
  }
  const chats = plan(options.users, options.scenario, options.seed);
  for (let index = 0; index < chats.length; index++) {
    const chat = chats[index];
    const creator = sockets[chat.members[0]];
    if (chat.kind === 'DIRECT') {
      const recipient = sockets[chat.members[1]].session.userId;
      const existing = await http.request(creator.session, `/chats/direct/${recipient}`);
      if (existing.chat) throw new Error('Planned direct pair already has a chat. Use a different seed or fresh disposable accounts; existing chats are never adopted');
      chat.anchor = await seed(creator, { recipientId: recipient });
      chat.id = chat.anchor.chatId;
    } else {
      const group = await http.request(creator.session, '/chats/groups', { method: 'POST', body: { name: `Feature load ${options.seed} ${index}`, memberIds: chat.members.slice(1).map(member => sockets[member].session.userId) } });
      chat.id = group.id;
      await creator.subscribe({ ...chat, baseline: '0' });
      chat.anchor = await seed(creator, { chatId: chat.id });
    }
    chat.mutable = await seed(creator, { chatId: chat.id });
    chat.owned = true;
    chat.baseline = chat.mutable.sequence;
  }
  await writePrivate(options.output, { format: 'messenger-features-topology-v1', seed: options.seed, scenario: options.scenario, sessions: sockets.map(socket => socket.session), chats });
  return chats;
}

export async function loadSource(options) {
  const source = await readPrivate(options.manifest);
  if (!Array.isArray(source.sessions) || source.sessions.length < options.users) throw new Error('Manifest has too few existing sessions');
  const sessions = source.sessions.slice(0, options.users);
  if (new Set(sessions.map(session => session.userId)).size !== sessions.length || sessions.some(session => !session.userId || !session.cookie)) throw new Error('Manifest requires distinct userId/cookie sessions');
  if (source.format === 'messenger-features-topology-v1' && source.sessions.length !== options.users) throw new Error('Saved topology requires identical user count');
  return { ...source, sessions };
}
