import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Device } from './device.mjs';
import { Measurements } from './transport.mjs';

async function withPeer(acknowledge, work, onClosing) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: messenger\r\n\r\n');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('end', () => socket.end());
    socket.on('data', bytes => {
      if ((bytes[0] & 15) !== 8) return;
      onClosing?.(socket);
      if (acknowledge) socket.end(Buffer.from([0x88, 0]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const metrics = new Measurements();
  const state = { http: { options: { ws: 'ws://127.0.0.1:' + server.address().port, origin: 'http://localhost' },
    controller, metrics, request: async () => ({ token: 'fixture' }) }, metrics };
  const device = new Device(state, {}, 0);
  try {
    await work(device);
    await Promise.all([...sockets].map(socket => once(socket, 'close', { signal: AbortSignal.timeout(1000) })));
    assert.equal(device.socket, null);
    assert.equal(sockets.size, 0);
  } finally {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('overlapping connects retain ownership and end replaced delivery lifecycles', { timeout: 5000 }, async () => {
  await withPeer(true, async device => {
    await Promise.all([device.connect(), device.connect()]);
    assert.equal(device.connection, 1);
    assert.equal(device.selection, 1);
    await device.close();
  });
});

test('shutdown terminates a socket whose peer ignores the close handshake', { timeout: 5000 }, async () => {
  await withPeer(false, async device => {
    await device.connect();
    const ws = device.socket.ws;
    const closing = device.close();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(device.socket);
    await closing;
    assert.equal(ws.readyState, WebSocket.CLOSED);
  });
});

test('retired socket frames cannot acknowledge the replacement subscription', { timeout: 5000 }, async () => {
  const chatId = '00000000000000000000000001';
  await withPeer(true, async device => {
    device.selected = { id: chatId };
    await device.connect();
    await device.connect();
    assert.equal(device.subscribedTo, null);
    assert.deepEqual(Object.keys(device.state.metrics.failures), []);
    await device.close();
  }, socket => {
    const payload = Buffer.from(JSON.stringify({ version: 1, type: 'subscribed', chatId }));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
});
