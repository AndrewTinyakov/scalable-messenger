import assert from 'node:assert/strict';
import { apiBase, clientOrigin } from './runtime.mjs';

let nextRegistrationAt = 0;

export async function api(path, { cookie, method = 'GET', body } = {}) {
  if (path === '/auth/register') {
    const wait = Math.max(0, nextRegistrationAt - Date.now());
    nextRegistrationAt = Math.max(Date.now(), nextRegistrationAt) + 1100;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const response = await fetch(`${apiBase}/v1${path}`, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...csrfHeaders(method),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  if (path === '/auth/register' || path === '/auth/login') {
    assert.deepEqual(Object.keys(payload).sort(), ['deviceId', 'user']);
    const cookies = response.headers.getSetCookie().filter((value) => value.startsWith('messenger_session='));
    assert.equal(cookies.length, 1);
    const setCookie = cookies[0];
    assert.match(setCookie, /; HttpOnly(?:;|$)/i);
    assert.match(setCookie, /; SameSite=Strict(?:;|$)/i);
    assert.match(setCookie, new RegExp(`; Path=${new URL(apiBase).pathname}(?:;|$)`, 'i'));
    assert.doesNotMatch(setCookie, /; Domain=/i);
    return { ...payload, cookie: setCookie.split(';')[0] };
  }
  if (path === '/auth/logout') {
    assert.ok(response.headers.getSetCookie().some((value) => value.startsWith('messenger_session=') && /; Max-Age=0(?:;|$)/i.test(value)));
  }
  return payload;
}

export function csrfHeaders(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method)
    ? {}
    : { origin: clientOrigin, 'x-messenger-csrf': '1' };
}
