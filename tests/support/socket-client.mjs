import { api } from './api-client.mjs';
import { wsUrl } from './runtime.mjs';

export async function connect(cookie) {
  const ticket = await api('/auth/ws-ticket', { cookie, method: 'POST' });
  const socket = new WebSocket(wsUrl, ['messenger', `messenger-ticket.${ticket.token}`]);
  const frames = [];
  const waiters = new Set();
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    frames.push(frame);
    for (const waiter of waiters) waiter();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebSocket open failed')); }, { once: true });
  });
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify({ version: 1, ...frame })),
    async waitFor(predicate, timeoutMs = 20000, after = 0) {
      const find = () => frames.slice(after).find((frame) => predicate(frame.event ?? frame));
      if (find()) return find();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`Timed out waiting for socket frame. Saw ${JSON.stringify(frames)}`)); }, timeoutMs);
        const check = () => {
          const frame = find();
          if (frame) { clearTimeout(timeout); waiters.delete(check); resolve(frame); }
        };
        waiters.add(check);
      });
    },
  };
}
