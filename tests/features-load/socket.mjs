import { performance } from 'node:perf_hooks';

export class Socket {
  constructor(index, session, http, options, metrics, receive) {
    Object.assign(this, { index, session, http, options, metrics, receive });
    this.chats = new Map();
    this.waiters = new Set();
    this.acks = new Map();
    this.connection = null;
    this.expectedClose = false;
    this.measuring = false;
    this.ackTimer = setInterval(() => this.flush(), 50);
  }
  async connect() {
    const ticket = await this.http.request(this.session, '/auth/ws-ticket', { method: 'POST', operation: 'ticket' });
    this.expectedClose = false;
    const connection = new WebSocket(this.options.ws, ['messenger', `messenger-ticket.${ticket.token}`]);
    this.connection = connection;
    connection.addEventListener('message', ({ data }) => {
      try {
        if (typeof data !== 'string' || data.length > 65536) throw new Error('Socket frame exceeds 64 KiB or is binary');
        const decoded = JSON.parse(data);
        const frame = decoded.event ?? decoded;
        if (this.measuring) this.metrics.count(`frame.${['message_saved', 'message_changed', 'presence', 'reads_changed', 'queued', 'send_rejected', 'error', 'recovery_failed', 'chat_deleted'].includes(frame.type) ? frame.type : 'other'}`);
        if (frame.type === 'message_saved') {
          if (!this.acks.has(frame.chatId) && this.acks.size >= 4096) throw new Error('ACK chat limit exceeded');
          const sequence = BigInt(frame.sequence);
          const prior = this.acks.get(frame.chatId);
          if (!prior || sequence > BigInt(prior.sequence)) this.acks.set(frame.chatId, { sequence: frame.sequence });
        }
        for (const waiter of this.waiters) {
          if (waiter.predicate(frame)) { this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(frame); }
        }
        this.receive(this, frame, performance.now());
      } catch (error) { this.metrics.failure('transport.decode', error); }
    });
    connection.addEventListener('close', () => {
      if (!this.expectedClose) this.metrics.count('transport.unexpectedClose');
      for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Socket closed')); }
      this.waiters.clear();
    });
    connection.addEventListener('error', () => { if (!this.expectedClose) this.metrics.count('transport.error'); });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { connection.close(); reject(new Error('Socket open timeout')); }, 15000);
      connection.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      connection.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Socket open failed')); }, { once: true });
      connection.addEventListener('close', () => { clearTimeout(timeout); reject(new Error('Socket closed before open')); }, { once: true });
    });
  }
  wait(predicate, ms = 20000) {
    if (this.waiters.size >= 64) throw new Error('Socket waiter limit exceeded');
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error('Socket response timed out')); }, ms);
      this.waiters.add(waiter);
    });
  }
  send(frame) {
    if (this.connection?.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify({ version: 1, ...frame });
    if (this.connection.bufferedAmount + data.length > 65536) { this.metrics.count('driver.writerBackpressure'); return false; }
    this.connection.send(data);
    return true;
  }
  flush() {
    for (const [chatId, position] of this.acks) {
      if (this.send({ type: 'applied', chatId, sequence: position.sequence })) this.acks.delete(chatId);
    }
  }
  async subscribe(chat) {
    this.chats.set(chat.id, chat);
    if (chat.kind !== 'GROUP') return;
    const ready = this.wait(frame => frame.type === 'subscribed' && frame.chatId === chat.id);
    if (!this.send({ type: 'subscribe', kind: chat.kind, chatId: chat.id, lastAppliedSequence: chat.baseline ?? '0' })) throw new Error('Subscribe send failed');
    await ready;
  }
  async disconnect() {
    this.expectedClose = true;
    this.acks.clear();
    const connection = this.connection;
    this.connection = null;
    if (!connection || connection.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2000);
      connection.addEventListener('close', () => { clearTimeout(timeout); resolve(); }, { once: true });
      connection.close();
    });
  }
  async close() {
    clearInterval(this.ackTimer);
    await this.disconnect();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error('Driver shutdown')); }
    this.waiters.clear();
    this.acks.clear();
  }
}
