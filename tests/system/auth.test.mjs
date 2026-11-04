import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, csrfHeaders } from '../support/api-client.mjs';
import { apiBase, wsUrl, clientOrigin } from '../support/runtime.mjs';
import { ulid } from '../support/fixtures.mjs';
import { connect } from '../support/socket-client.mjs';
import { randomBytes } from 'node:crypto';

test('public ingress hides internal endpoints and rejects oversized authentication bodies', async () => {
  const socketBase = new URL(wsUrl);
  socketBase.protocol = socketBase.protocol === 'wss:' ? 'https:' : 'http:';
  for (const url of [
    new URL('/metrics', socketBase),
    new URL('/healthz', socketBase),
    new URL('/readyz', socketBase),
    new URL(`${new URL(apiBase).pathname}/actuator`, apiBase),
    new URL(`${new URL(apiBase).pathname}/actuator/prometheus`, apiBase),
    new URL(`${new URL(apiBase).pathname}/v3/api-docs`, apiBase),
  ]) {
    const response = await fetch(url);
    assert.equal(response.status, 404, `${url.pathname} must remain private`);
  }
  const response = await fetch(`${apiBase}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeaders('POST') },
    body: JSON.stringify({ username: 'oversized', password: 'a'.repeat(40000) }),
  });
  assert.equal(response.status, 413);
  for (const path of ['/v1/auth/login;probe', '/v1/auth/register%3Bprobe']) {
    const bypass = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...csrfHeaders('POST') },
      body: '{}',
    });
    assert.equal(bypass.status, 404, `${path} must not bypass auth limits`);
  }
});

test('cookie sessions restore identity and reject forged mutations through public ingress', async () => {
  const suffix = randomBytes(5).toString('hex');
  const account = await api('/auth/register', {
    method: 'POST', body: { username: `cookie_${suffix}`, password: 'long-demo-password' },
  });
  assert.deepEqual(await api('/auth/session', { cookie: account.cookie }), {
    userId: account.user.id, username: account.user.username, deviceId: account.deviceId,
  });
  for (const headers of [
    { authorization: `Bearer ${account.cookie.split('=')[1]}` },
    { cookie: `${account.cookie}; ${account.cookie}` },
    { cookie: account.cookie, 'x-messenger-user': ulid(), 'x-messenger-device': account.deviceId },
  ]) {
    const response = await fetch(`${apiBase}/v1/chats`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 401);
  }
  for (const headers of [
    {},
    { origin: clientOrigin },
    { 'x-messenger-csrf': '1' },
    { origin: 'null', 'x-messenger-csrf': '1' },
    { origin: 'https://attacker.example', 'x-messenger-csrf': '1' },
    { origin: clientOrigin, 'x-messenger-csrf': '0' },
  ]) {
    const response = await fetch(`${apiBase}/v1/auth/logout`, {
      method: 'POST', headers: { cookie: account.cookie, ...headers }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.getSetCookie().length, 0);
  }
  assert.equal((await api('/auth/session', { cookie: account.cookie })).userId, account.user.id);
  const staleLogout = await fetch(`${apiBase}/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie: account.cookie, ...csrfHeaders('POST'), 'x-messenger-user': ulid(), 'x-messenger-device': account.deviceId },
  });
  assert.equal(staleLogout.status, 401);
  assert.equal(staleLogout.headers.getSetCookie().length, 0);
  assert.equal((await api('/auth/session', { cookie: account.cookie })).userId, account.user.id);
  const preflight = await fetch(`${apiBase}/v1/auth/ws-ticket`, {
    method: 'OPTIONS',
    headers: { origin: clientOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-messenger-csrf,x-messenger-user,x-messenger-device' },
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('access-control-allow-origin'), clientOrigin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  await api('/auth/logout', { cookie: account.cookie, method: 'POST' });
});

test('logout revokes HTTP access, live sockets, and previously issued socket tickets', { timeout: 30000 }, async (t) => {
  const suffix = randomBytes(5).toString('hex');
  const account = await api('/auth/register', {
    method: 'POST', body: { username: `revoke_${suffix}`, password: 'long-demo-password' },
  });
  const client = await connect(account.cookie);
  t.after(() => client.socket.close());
  const ticket = await api('/auth/ws-ticket', { cookie: account.cookie, method: 'POST' });
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Revoked socket remained open')), 15000);
    client.socket.addEventListener('close', (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
  await api('/auth/logout', { cookie: account.cookie, method: 'POST' });
  assert.equal((await closed).code, 4003);

  for (const [path, method] of [['/auth/session', 'GET'], ['/chats', 'GET'], ['/auth/ws-ticket', 'POST']]) {
    const response = await fetch(`${apiBase}/v1${path}`, {
      method, headers: { cookie: account.cookie, ...csrfHeaders(method) }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 401, `${path} accepted a revoked session`);
  }

  const staleSocket = new WebSocket(wsUrl, ['messenger', `messenger-ticket.${ticket.token}`]);
  t.after(() => staleSocket.close());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Revoked ticket handshake remained pending')), 10000);
    staleSocket.addEventListener('message', () => {
      clearTimeout(timeout);
      reject(new Error('Previously issued ticket received room events after logout'));
    }, { once: true });
    staleSocket.addEventListener('close', (event) => {
      clearTimeout(timeout);
      try {
        assert.equal(event.code, 4003);
        resolve();
      } catch (error) { reject(error); }
    }, { once: true });
    staleSocket.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
});
