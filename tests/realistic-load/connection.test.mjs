import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Device } from './device.mjs';
import { Measurements } from './transport.mjs';

test('overlapping connects retain ownership of every socket through shutdown', async () => {
  const sockets = new Set();
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: messenger\r\n\r\n');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', bytes => { if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const metrics = new Measurements();
  const state = { http: { options: { ws: 'ws://127.0.0.1:' + server.address().port, origin: 'http://localhost' },
    controller, metrics, request: async () => ({ token: 'fixture' }) }, metrics };
  const device = new Device(state, {}, 0);
  try {
    await Promise.all([device.connect(), device.connect()]);
    await device.close();
    await Promise.all([...sockets].map(socket => once(socket, 'close', { signal: AbortSignal.timeout(1000) })));
    assert.equal(device.socket, null);
    assert.equal(sockets.size, 0);
  } finally {
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

